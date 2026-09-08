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
 *          COMPLETENESS IS NOT THIS FILE'S JOB and it must not pretend
 *          otherwise. Whether the two vocabularies cover every variable Ag
 *          actually writes is decided at the root, which can see both
 *          repositories: tools/hab-session-vocabulary.integration.test.ts.
 *
 * @level   l1 — the real sanitizer, no fixture of the function under test
 * @consumer `createHealthProcessSource`, whose contradictory-environment branch
 *           reads this exact marker list, and through it the disk-blindness alert
 *           that stayed silent while a 61G tmpfs filled on 2026-09-07
 * @bead    @i/4-supervision/24233-tmpfs-has-no-reaper (@cto's carried-forward term)
 */
describe("the markers list and the standalone sanitizer agree on one vocabulary", () => {
  // THIS LIST IS NOT A COMPLETENESS CLAIM, and an earlier version of this file
  // made one. It named itself EVERY_HAB_SESSION_VARIABLE and offered a manual
  // grep as its staleness story, which made it a THIRD hardcoded vocabulary: a
  // new or renamed Ag-written variable changed none of the two subjects NOR
  // this list, so every case here stayed green while the producer drifted —
  // exactly the failure this file exists to prevent (@ci, P1 on af774852).
  //
  // Completeness is not expressible in this package. A Tribe test cannot import
  // Ag, so it cannot know what Ag writes. That job belongs to, and now lives
  // in, the root contract at tools/hab-session-vocabulary.integration.test.ts,
  // which derives the population from Ag's own source and is proven red by
  // adding and by renaming an Ag variable.
  //
  // What THIS file still proves, and proves well, is the agreement between the
  // two vocabularies that live in Tribe: whatever names are put in, the ones
  // that survive sanitizing are exactly the ones the source calls markers. The
  // sample below is enough to exercise that, and it is a SAMPLE.
  const SAMPLE_HAB_SESSION_VARIABLES = [
    "HAB_SESSION_DIR",
    "HAB_SESSION_HABITAT_ROOT",
    "HAB_SESSION_INSTRUCTION_ANCHOR",
    "HAB_SESSION_LAUNCH_ID",
  ] as const

  const habLaunchedEnvironment = (): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(SAMPLE_HAB_SESSION_VARIABLES.map((name) => [name, `value-of-${name}`])),
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

})
