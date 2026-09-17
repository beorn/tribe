/**
 * Test processes never touch a managed seat's own fleet state.
 *
 * A managed seat's shell carries two things a spawned test child must not inherit.
 *
 * Its declared roster, two ways: TRIBE_EXPECTED_MEMBERS (or TRIBE_EXPECTED_MEMBERS_FILE),
 * and HAB_SESSION_HABITAT_ROOT, whose tribe-expected-members.json the daemon loads when no
 * file is named (membership-declared-roster.ts resolvedRosterFile). A test that spawns a
 * daemon from process.env then judges every fleet seat never-registered. Measured
 * 2026-09-16: cli.test.ts "doctor proves the rail" failed from a seat shell on tribe
 * 4dfdeb451 and on its parent, and passed with these three keys removed.
 *
 * Its launch state directory, AG_HOST_SESSION_STATE_DIR, where the plugin supervisor
 * appends one line per adapter exit (packages/wire/src/lib/adapter-exit-record.ts). A test
 * plugin spawned from process.env would write its exits into the seat's real record and
 * register that path as its own.
 *
 * Setup files run before any test module loads, so every spawned child inherits the
 * removal. A test that needs a roster or a launch state directory passes one explicitly.
 */
for (const key of [
  "TRIBE_EXPECTED_MEMBERS",
  "TRIBE_EXPECTED_MEMBERS_FILE",
  "HAB_SESSION_HABITAT_ROOT",
  "AG_HOST_SESSION_STATE_DIR",
]) {
  delete process.env[key]
}
