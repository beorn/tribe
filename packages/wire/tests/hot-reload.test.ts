import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { setupHotReload } from "../src/lib/hot-reload.ts"

describe("source hot reload replacement ownership", () => {
  it("delegates replacement to the stable plugin supervisor when supplied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-hot-reload-"))
    const source = join(dir, "adapter.ts")
    writeFileSync(source, "export const generation = 1\n")
    const replaceProcess = vi.fn()
    const reload = setupHotReload({
      importMetaUrl: pathToFileURL(source).href,
      debounceMs: 10,
      replaceProcess,
    })

    try {
      writeFileSync(source, "export const generation = 2\n")
      await vi.waitFor(() => expect(replaceProcess).toHaveBeenCalledOnce(), { timeout: 5_000, interval: 20 })
      expect(replaceProcess).toHaveBeenCalledWith(expect.stringContaining("source changed"))
    } finally {
      reload?.[Symbol.dispose]()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
