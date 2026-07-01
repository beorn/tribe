import { describe, expect, it } from "vitest"
import { resolveDeliveryCapability, resolveJoinDelivery } from "../src/lib/delivery.ts"

describe("resolveJoinDelivery", () => {
  it("ignores model-requested push for pull-only adapters", () => {
    expect(
      resolveJoinDelivery({
        adapterDelivery: "pull",
        requestedDelivery: "push",
        allowRequestedDelivery: false,
      }),
    ).toBe("pull")
  })

  it("allows requested delivery only when the adapter has a push-capable channel", () => {
    expect(
      resolveJoinDelivery({
        adapterDelivery: "push",
        requestedDelivery: "pull",
        allowRequestedDelivery: true,
      }),
    ).toBe("pull")
  })

  it("falls back to adapter delivery for invalid requested values", () => {
    expect(
      resolveJoinDelivery({
        adapterDelivery: "pull",
        requestedDelivery: "sometimes",
        allowRequestedDelivery: true,
      }),
    ).toBe("pull")
  })
})

describe("resolveDeliveryCapability", () => {
  it("advertises channel delivery when the adapter can push channel notifications", () => {
    expect(resolveDeliveryCapability({ delivery: "push", channel: true })).toMatchObject({
      delivery: "push",
      channel: true,
      pullTransport: null,
      idleStrategy: "channel",
    })
  })

  it("keeps pull as delivery mode and names cli as the pull transport", () => {
    expect(resolveDeliveryCapability({ delivery: "pull", channel: false, pullTransport: "cli" })).toMatchObject({
      delivery: "pull",
      channel: false,
      pullTransport: "cli",
      idleStrategy: "cli-inbox-wait",
    })
  })

  it("supports host-stream as a pull transport for hosts with their own stream", () => {
    expect(resolveDeliveryCapability({ delivery: "pull", channel: false, pullTransport: "host-stream" })).toMatchObject(
      {
        delivery: "pull",
        channel: false,
        pullTransport: "host-stream",
        idleStrategy: "host-stream",
      },
    )
  })
})
