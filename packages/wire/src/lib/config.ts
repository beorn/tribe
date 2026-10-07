/**
 * Tribe configuration — CLI args, env vars, path resolution, role/name detection.
 *
 * 27941: this module used to hold all of the above in one file, so every consumer paid
 * `@bearly/flock` and `removely` at import whether or not it locked a DB or probed for
 * `.beads/`. Both halves of every tribe bridge import a slice of this surface at startup,
 * so that was ~2.8 MB + ~2.1 MB per supervisor and ~2.8 MB per adapter child, on every
 * launch. The content now lives in three modules by dependency, and this file is a barrel
 * that keeps the `tribe-wire/lib/config` surface unchanged for every existing importer:
 *
 *   - `config-light`  — args, roles, session/project identity; no flock, no removely.
 *   - `beads-path`    — `.beads/` discovery; the only home of removely.
 *   - `db-path`       — DB location and its migration lock; the only home of flock.
 *
 * The bridge halves import the narrow modules directly (the supervisor needs only
 * `config-light`; the adapter child adds `beads-path`), so startup no longer builds either
 * dependency. Anyone importing `tribe-wire/lib/config` keeps today's behaviour exactly,
 * including paying for both — that is the compatibility half of the split, not a defect.
 */

export * from "./config-light.ts"
export * from "./beads-path.ts"
export * from "./db-path.ts"
