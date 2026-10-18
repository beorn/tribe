/**
 * Redirect TMPDIR to a bounded, self-sweeping base before any test runs.
 *
 * The shared macOS per-user tmpdir (/var/folders/.../T) accumulates leaked
 * mkdtemp fixtures from killed and timed-out runs (afterEach cleanup never
 * fires). Sustained create/delete churn bloats that directory's btree until
 * a full readdir takes minutes — and bun's startup enumerates the cwd
 * ancestor chain, so any spawned bun subprocess whose cwd or socket dir
 * lives under it wedges past testTimeout (45 tribe/recall/github tests
 * timed out this way on 2026-06-11; the same file passed in 0.7s with
 * TMPDIR redirected).
 *
 * os.tmpdir() reads process.env.TMPDIR at call time, so setting it here —
 * setup files run before any test module loads — moves every
 * `mkdtempSync(join(tmpdir(), ...))` fixture under a bounded base with zero
 * call-site edits. Children inherit the env. Entries older than 24h are
 * swept at worker startup so leaks can never re-accumulate into the same
 * pathology.
 */
import { randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { pinTribeLogGuards } from "./tribe-log-guards.ts"

// realpathSync: /tmp is a symlink to /private/tmp on macOS — tools that
// compare resolved paths against fixture paths (e.g. the ripgrep-backed
// wikilink find) mismatch unless TMPDIR is already canonical.
mkdirSync(`/tmp/tribe-vitest-${process.getuid?.() ?? 0}`, { recursive: true })
const TEST_TMP_BASE = realpathSync(`/tmp/tribe-vitest-${process.getuid?.() ?? 0}`)
process.env.TMPDIR = TEST_TMP_BASE
// The two HOME-fallback log paths (@i/17-test-system/25264) — the same module the root
// `vendor` project composes through tools/test-tribe-log-setup.ts, called here AFTER the
// TMPDIR redirect so both guards' files land under the swept base.
pinTribeLogGuards()
const STALE_CUTOFF_MS = Date.now() - 24 * 60 * 60 * 1000
for (const name of readdirSync(TEST_TMP_BASE)) {
  const stale = join(TEST_TMP_BASE, name)
  // A readdir walk that deletes each entry is the exact shape of the 2026-07-31
  // incident, so this loop of all places routes through the guarded primitive.
  //
  // The try/catch is now scoped to the stat alone. It used to wrap the removal
  // too, which meant a containment REFUSAL would have been swallowed by the
  // same `catch {}` that legitimately absorbs the worker race — the failure
  // mode where the guard fires and nobody hears it.
  let mtimeMs: number
  try {
    mtimeMs = statSync(stale).mtimeMs
  } catch {
    // Concurrent workers race to sweep the same stale entry; losing the race
    // (ENOENT between readdir and stat) is the expected outcome, not an error.
    continue
  }
  if (mtimeMs < STALE_CUTOFF_MS) safeRemoveSync(stale, { within: TEST_TMP_BASE, allowMissing: true })
}
// Socket guard — tests must NEVER reach the real per-user tribe daemon.
// resolveSocketPath() falls back TRIBE_SOCKET -> XDG_RUNTIME_DIR ->
// ~/.local/share/tribe/tribe.sock, so an unset env in a test-spawned CLI or
// adapter resolves to the LIVE daemon socket (the 2026-06-12 daemon-death
// incident made the class concrete even though no test was proven lethal).
// Hermetic by construction: point the env fallback at a unique per-setup
// path. The unique directory matters because killed live-daemon tests can
// leave detached processes behind; a fixed "never-created" socket path
// eventually becomes a real accepting socket. Tests that want a daemon pass an
// explicit --socket or set TRIBE_SOCKET themselves (explicit always wins over
// this default).
const TRIBE_GUARD_DIR = join(TEST_TMP_BASE, "tribe-guard", randomUUID())
mkdirSync(TRIBE_GUARD_DIR, { recursive: true })
process.env.TRIBE_SOCKET = join(TRIBE_GUARD_DIR, "tribe.sock")

// Injection-record guard — the identical hazard, a fourth time: the record writer
// (packages/injection-envelope/src/debug.ts, ensureFileWriter) falls back to
// ~/.local/share/bearly/injection.jsonl whenever INJECTION_DEBUG_LOG and
// LOGGILY_FILE are both unset (hook-dispatch.ts resolves the same three names).
// The injection-envelope tests install a scratch writer for their assertions and
// then emit rows, and the emit installs that fallback too — so every test run
// wrote tens of MiB of fixture rows into the operator's real record. That was
// growth while the record had no bound; since the bound landed it is DESTRUCTION,
// because the writer rotates what it can no longer measure: on 2026-10-16 a single
// `vitest run` of packages/injection-envelope rotated the real 251,832,256 B
// record aside as `<path>.1` and the same run's next 32 MiB replaced it.
//
// Same fix shape as the guards above, widened by one clause: pin when nothing
// names a path, and also when what names one points into the real per-user state
// directory (a seat or CI shell exporting LOGGILY_FILE at a live log must not
// decide where tests write). Explicit always wins otherwise — a test that wants
// its own path still sets INJECTION_DEBUG_LOG or LOGGILY_FILE itself, and an
// explicit installInjectionFileWriter(path) is unaffected either way.
const declaredRecordPath = process.env.INJECTION_DEBUG_LOG ?? process.env.LOGGILY_FILE
if (declaredRecordPath === undefined || declaredRecordPath.startsWith(join(homedir(), ".local", "share"))) {
  // Per-process, like the socket guard's unique directory: two workers sharing one
  // record would rotate under each other, and the file is swept with the rest of
  // TEST_TMP_BASE after 24h.
  process.env.INJECTION_DEBUG_LOG = join(TEST_TMP_BASE, `injection-record-guard-${process.pid}.jsonl`)
}
