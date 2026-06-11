/**
 * Vitest config for the tribe monorepo.
 *
 * Run: `bun run test` (bunx --bun vitest run — the recall engine needs the
 * bun runtime for bun:sqlite).
 */

import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["packages/**/tests/**/*.test.ts", "packages/daemon/src/**/*.test.ts", "plugins/**/tests/**/*.test.ts"],
    // .slow. tests hit real services (sockets, daemons) — opt-in only.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.slow.*"],
    // tmpdir-redirect keeps fixtures/sockets out of the shared macOS tmpdir,
    // whose degraded readdir wedges spawned bun subprocesses (see file header).
    setupFiles: ["tests/setup/tmpdir-redirect.ts"],
  },
})
