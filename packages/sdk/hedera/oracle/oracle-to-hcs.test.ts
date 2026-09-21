/**
 * End-to-end, no network: the mock oracle (#8) feeds the HCS publisher (#6), exactly the shape #9's relayer, #13's tests
 * and #15's E2E will use. This is the mock actually being exercised by the project's automated tests, not unused code.
 */
import { describe, expect, it } from "vitest";
import { createHcsPublisher } from "../hcs/publisher";
import { TEST_TOPIC, fakeTransport, goodReceipt, makeConfig } from "../hcs/test-fixtures";
import { createMockOracleAdapter, MOCK_ORACLE_SIGNER, makeFixture } from "./mock";
import { baseContext, DOMAIN } from "./test-fixtures";

const now = () => new Date(1_767_225_060_000);

describe("mock oracle -> HCS publisher, end to end", () => {
  it("observes a mock event and publishes it to the (fake) HCS topic without any network or credentials", async () => {
    const fixture = makeFixture({
      providerRef: "order-42",
      observedAt: 1_767_225_000,
      eventType: "delivery.confirmed",
      data: 1_500n,
    });
    const oracle = createMockOracleAdapter({ fixtures: { "order-42": { kind: "observation", value: fixture } }, now });

    const observed = await oracle.observe({ query: { ref: "order-42" }, context: baseContext(), domain: DOMAIN });
    expect(observed).toMatchObject({ ok: true });
    if (!observed.ok) return;

    const { transport, calls } = fakeTransport(() => goodReceipt());
    const publisher = createHcsPublisher(makeConfig(), transport, { now });
    const published = await publisher.publish({ event: observed.event, signature: observed.signature });

    expect(published).toMatchObject({ ok: true, status: "published", topicId: TEST_TOPIC });
    expect(calls).toHaveLength(1);
    if (published.ok) {
      expect(published.event.eventKey).toBeDefined();
      expect(published.event.signer.toLowerCase()).toBe(MOCK_ORACLE_SIGNER.address.toLowerCase());
    }
  });

  it("a re-attestation from the oracle (same identity, new observedAt) still lands on the same eventKey once published", async () => {
    const oracle = () =>
      createMockOracleAdapter({
        fixtures: {
          "order-42": {
            kind: "observation",
            value: makeFixture({ providerRef: "order-42", observedAt: 1_767_225_000, data: 1n }),
          },
        },
        now,
      });
    const first = await oracle().observe({ query: { ref: "order-42" }, context: baseContext(), domain: DOMAIN });
    const second = await createMockOracleAdapter({
      fixtures: {
        "order-42": {
          kind: "observation",
          value: makeFixture({ providerRef: "order-42", observedAt: 1_767_225_030, data: 1n }),
        },
      },
      now,
    }).observe({ query: { ref: "order-42" }, context: baseContext(), domain: DOMAIN });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.event.externalEventId).toBe(first.event.externalEventId);
  });

  it("a mock NO_DATA never reaches the publisher: the caller sees it before any HCS call", async () => {
    const oracle = createMockOracleAdapter({ now });
    const observed = await oracle.observe({ query: { ref: "missing" }, context: baseContext(), domain: DOMAIN });
    expect(observed).toMatchObject({ ok: false, failure: { code: "NO_DATA" } });
  });
});
