import { describe, expect, it, vi } from "vitest"
import { createLineParser } from "../src/parser.ts"
import { makeResponse, type JsonRpcMessage } from "../src/rpc.ts"

describe("createLineParser", () => {
  /**
   * @failure A fragmented full-history response exhausts the RPC deadline while framing.
   * @level l0
   * @consumer daemon client callers, including tribe log --all
   * @testonly none
   * #27274: tiny messages never expose repeated scans of a growing prefix.
   * The ten-second budget is the existing RPC deadline, with ample headroom
   * for linear framing of this much smaller than live-history response.
   */
  it("frames a large fragmented response within the RPC budget without losing values", () => {
    const result = { content: "x".repeat(8 * 1024 * 1024), tail: "complete" }
    const encoded = Buffer.from(makeResponse(7, result))
    const out: JsonRpcMessage[] = []
    const parse = createLineParser((message) => out.push(message))
    const started = performance.now()
    for (let offset = 0; offset < encoded.length; offset += 128) {
      parse(encoded.subarray(offset, offset + 128))
    }
    const elapsed = performance.now() - started
    expect(out).toEqual([{ jsonrpc: "2.0", id: 7, result }])
    expect(elapsed).toBeLessThan(10_000)
  }, 90_000)

  it("emits one message per complete \\n-terminated JSON line", () => {
    const out: JsonRpcMessage[] = []
    const parse = createLineParser((m) => out.push(m))
    parse(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n'))
    expect(out).toHaveLength(2)
    expect((out[0] as { method: string }).method).toBe("a")
    expect((out[1] as { method: string }).method).toBe("b")
  })

  it("buffers incomplete trailing lines until completed by a later chunk", () => {
    const out: JsonRpcMessage[] = []
    const parse = createLineParser((m) => out.push(m))
    parse(Buffer.from('{"jsonrpc":"2.0","id":1,"meth'))
    expect(out).toHaveLength(0)
    parse(Buffer.from('od":"a"}\n{"jsonrpc":"2.0","id":2,'))
    expect(out).toHaveLength(1)
    parse(Buffer.from('"method":"b"}\n'))
    expect(out).toHaveLength(2)
    expect((out[1] as { id: number }).id).toBe(2)
  })

  it("skips invalid JSON without throwing and reports it via onInvalid", () => {
    // The parser still emits its operator-facing loggily warning. Silence that
    // expected warning under km's console-clean test harness; assert behavior
    // through the explicit invalid-line seam instead of console output.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const invalid: string[] = []
    const out: JsonRpcMessage[] = []
    try {
      const parse = createLineParser(
        (m) => out.push(m),
        (line) => invalid.push(line),
      )
      // Core contract: don't throw on a bad line, still emit the valid line after it.
      expect(() => parse(Buffer.from('not-json\n{"jsonrpc":"2.0","id":1,"method":"a"}\n'))).not.toThrow()
      expect(out).toHaveLength(1)
      expect((out[0] as { method: string }).method).toBe("a")
      // And surface the bad input explicitly.
      expect(invalid).toEqual(["not-json"])
    } finally {
      warnSpy.mockRestore()
    }
  })
})
