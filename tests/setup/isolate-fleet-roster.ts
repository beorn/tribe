/**
 * Test daemons own their declared roster.
 *
 * A managed seat's shell carries the fleet's roster two ways: TRIBE_EXPECTED_MEMBERS
 * (or TRIBE_EXPECTED_MEMBERS_FILE), and HAB_SESSION_HABITAT_ROOT, whose
 * tribe-expected-members.json the daemon loads when no file is named
 * (membership-declared-roster.ts resolvedRosterFile). A test that spawns a daemon
 * from process.env then judges every fleet seat never-registered. Measured
 * 2026-09-16: cli.test.ts "doctor proves the rail" failed from a seat shell on
 * tribe 4dfdeb451 and on its parent, and passed with these three keys removed.
 *
 * Setup files run before any test module loads, so every spawned child inherits
 * the removal. A test that needs a roster passes one explicitly.
 */
for (const key of ["TRIBE_EXPECTED_MEMBERS", "TRIBE_EXPECTED_MEMBERS_FILE", "HAB_SESSION_HABITAT_ROOT"]) {
  delete process.env[key]
}
