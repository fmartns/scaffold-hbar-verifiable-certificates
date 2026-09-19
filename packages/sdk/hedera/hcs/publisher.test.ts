import { hexlify } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { encodeMessage, buildEnvelope } from "./envelope";
import { HcsPublishError } from "./errors";
import {
  createHcsPublisher,
  hashscanTopicUrl,
  hashscanTransactionUrl,
  interpretReceipt,
  timestampToNanoseconds,
  toMirrorTransactionId,
  unwrapPublish,
} from "./publisher";
import type { PublishFailureResult, PublishSuccess } from "./publisher";
import { NETWORKS } from "../networks";
import {
  FIXED_CONSENSUS,
  FIXED_NOW,
  FIXED_TX_ID,
  TEST_ROUTER,
  TEST_SIGNER,
  TEST_SIGNER_KEY,
  TEST_TOPIC,
  fakeTransport,
  goodReceipt,
  hederaError,
  makeConfig,
  makeEvent,
  signEvent,
} from "./test-fixtures";

async function input(eventOverrides = {}) {
  const event = makeEvent(eventOverrides);
  return { event, signature: await signEvent(event) };
}

const options = { now: () => FIXED_NOW };
const asSuccess = (r: unknown) => r as PublishSuccess;
const asFailure = (r: unknown) => (r as PublishFailureResult).error;

describe("successful publication", () => {
  it("returns identification, topic, transaction id, HashScan link and status", async () => {
    const { transport } = fakeTransport(() => goodReceipt());
    const publisher = createHcsPublisher(makeConfig(), transport, options);
    const result = await publisher.publish(await input());

    expect(result.ok).toBe(true);
    const ok = asSuccess(result);
    expect(ok.status).toBe("published");
    expect(ok.topicId).toBe(TEST_TOPIC);
    expect(ok.network).toBe("testnet");
    expect(ok.transactionId).toBe(FIXED_TX_ID);
    expect(ok.mirrorTransactionId).toBe("0.0.1234-1767225600-123456789");
    expect(ok.hashscanUrl).toBe(`https://hashscan.io/testnet/transaction/${FIXED_CONSENSUS}`);
    expect(ok.hashscanTopicUrl).toBe(`https://hashscan.io/testnet/topic/${TEST_TOPIC}`);
    expect(ok.event).toEqual({
      eventKey: "0xa443f61dfefa9b88087f5580a4365b62f4ff0f44b0cbd672d3323946ed6a27b8",
      settlementId: "0x131e2da33ac18ad10a946d80f3d56cc5a5929d05acf69372fae39fe46a85d9af",
      attestationDigest: "0x6b61fe09abfef4297d0e324de7c510eab9d5b4d6e9021789a34da052b604c905",
      contentHash: "0x217eb9b439c7478c295d3484ab573bf880892c15d3e5df2cd6bbb0c529bdfa91",
      eventSource: makeEvent().eventSource,
      externalEventId: makeEvent().externalEventId,
      signer: TEST_SIGNER.address.toLowerCase(),
    });
  });

  it("exposes the HcsRef claim, running hash and consensus timestamp from the receipt/record (NV-6)", async () => {
    const { transport } = fakeTransport(() => goodReceipt());
    const ok = asSuccess(await createHcsPublisher(makeConfig(), transport, options).publish(await input()));
    expect(ok.hcsRef).toEqual({ sequence: "17", consensusTimestampNs: "1767225605987654321" });
    expect(ok.consensusTimestamp).toBe(FIXED_CONSENSUS);
    expect(ok.runningHash).toBe(`0x${"ab".repeat(48)}`);
  });

  it("sends exactly the serialized envelope to the configured topic", async () => {
    const { transport, calls } = fakeTransport(() => goodReceipt());
    const publisher = createHcsPublisher(makeConfig(), transport, options);
    const payload = await input();
    await publisher.publish(payload);

    const envelope = buildEnvelope(payload, { chainId: 296, verifyingContract: TEST_ROUTER });
    if (!envelope.ok) throw new Error("fixture invalid");
    expect(calls).toHaveLength(1);
    expect(calls[0].topicId).toBe(TEST_TOPIC);
    expect(hexlify(calls[0].message)).toBe(hexlify(encodeMessage(envelope.value)));
    expect(calls[0].message[0]).toBe(1);
  });

  it("uses the configured topic and timeout, not a fixed one", async () => {
    const { transport, calls } = fakeTransport(() => goodReceipt());
    await createHcsPublisher(
      makeConfig("testnet", { topicId: "0.0.777", timeoutMs: 4321 }),
      transport,
      options,
    ).publish(await input());
    expect(calls[0].topicId).toBe("0.0.777");
    expect(calls[0].timeoutMs).toBe(4321);
  });

  it("builds the audit metadata", async () => {
    const { transport } = fakeTransport(() => goodReceipt());
    const ok = asSuccess(await createHcsPublisher(makeConfig(), transport, options).publish(await input()));
    expect(ok.audit).toEqual({
      schema: "hcs-evidence/v1",
      messageFormatVersion: 1,
      messageBytes: 482,
      messageSha256: "0xf94367aef65c087723224cb860362ac51deb0d3e76781049f93088602fae2be2",
      network: "testnet",
      chainId: 296,
      routerAddress: TEST_ROUTER,
      mirrorMessageUrl: `https://testnet.mirrornode.hedera.com/api/v1/topics/${TEST_TOPIC}/messages/17`,
      recordedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("returns a JSON-safe record that survives persistence unchanged", async () => {
    const { transport } = fakeTransport(() => goodReceipt());
    const ok = asSuccess(await createHcsPublisher(makeConfig(), transport, options).publish(await input()));
    expect(JSON.parse(JSON.stringify(ok))).toEqual(ok);
  });

  it("is deterministic: the same input yields the same result", async () => {
    const { transport } = fakeTransport(() => goodReceipt());
    const publisher = createHcsPublisher(makeConfig(), transport, options);
    expect(await publisher.publish(await input())).toEqual(await publisher.publish(await input()));
  });

  it("builds the HashScan link for the configured network", async () => {
    const mainnet = asSuccess(
      await createHcsPublisher(makeConfig("mainnet"), fakeTransport(() => goodReceipt()).transport, options).publish(
        await (async () => {
          const event = makeEvent();
          return { event, signature: await signEvent(event, TEST_ROUTER, 295) };
        })(),
      ),
    );
    expect(mainnet.hashscanUrl).toBe(`https://hashscan.io/mainnet/transaction/${FIXED_CONSENSUS}`);
    expect(hashscanTransactionUrl(NETWORKS.local, FIXED_CONSENSUS)).toBeNull();
    expect(hashscanTopicUrl(NETWORKS.local, TEST_TOPIC)).toBeNull();
  });

  it("binds the attestation to the network's chain id: a testnet signature is rejected on mainnet (replay class E)", async () => {
    const { transport, calls } = fakeTransport(() => goodReceipt());
    const publisher = createHcsPublisher(makeConfig("mainnet"), transport, {
      ...options,
      expectedSigner: TEST_SIGNER.address,
    });
    const result = await publisher.publish(await input());
    expect(asFailure(result)).toMatchObject({ code: "INVALID_EVENT", outcome: "not_sent" });
    expect(calls).toHaveLength(0);
  });
});

describe("invalid input never reaches the network", () => {
  it("returns INVALID_EVENT with the field issues", async () => {
    const { transport, calls } = fakeTransport(() => goodReceipt());
    const result = await createHcsPublisher(makeConfig(), transport, options).publish({
      event: makeEvent({ policyId: `0x${"00".repeat(32)}`, data: "0xzz" }),
      signature: "0x00",
    });
    const error = asFailure(result);
    expect(error).toMatchObject({ code: "INVALID_EVENT", outcome: "not_sent", retryable: false, topicId: TEST_TOPIC });
    expect(error.issues?.map(i => i.field)).toEqual(expect.arrayContaining(["policyId", "data", "signature"]));
    expect(calls).toHaveLength(0);
  });

  it("rejects an unexpected signer", async () => {
    const { transport, calls } = fakeTransport(() => goodReceipt());
    const publisher = createHcsPublisher(makeConfig(), transport, {
      ...options,
      expectedSigner: "0x00000000000000000000000000000000000000bb",
    });
    expect(asFailure(await publisher.publish(await input())).issues?.[0].code).toBe("SIGNER_MISMATCH");
    expect(calls).toHaveLength(0);
  });

  it("refuses to be built with an incomplete configuration", () => {
    const { transport } = fakeTransport(() => goodReceipt());
    expect(() => createHcsPublisher({ ...makeConfig(), topicId: "" }, transport)).toThrow(HcsPublishError);
  });
});

describe("failures are explicit, normalized and never retried", () => {
  async function failWith(behaviour: Parameters<typeof fakeTransport>[0], config = makeConfig()) {
    const { transport, calls } = fakeTransport(behaviour);
    const result = await createHcsPublisher(config, transport, options).publish(await input());
    return { result, error: asFailure(result), calls };
  }

  it("invalid or nonexistent topic", async () => {
    const { result, error, calls } = await failWith(() => {
      throw hederaError("PrecheckStatusError", "INVALID_TOPIC_ID");
    });
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(error).toMatchObject({
      code: "TOPIC_INVALID",
      outcome: "rejected",
      hederaStatus: "INVALID_TOPIC_ID",
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("network unavailable before anything was sent", async () => {
    const { error, calls } = await failWith(() => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    });
    expect(error).toMatchObject({ code: "NETWORK_UNAVAILABLE", outcome: "not_sent", retryable: true });
    expect(calls).toHaveLength(1);
  });

  it("network failure after the transaction id existed is an unknown outcome that carries the id", async () => {
    const { error } = await failWith(request => {
      request.onTransactionId(FIXED_TX_ID);
      throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    });
    expect(error).toMatchObject({ code: "NETWORK_UNAVAILABLE", outcome: "unknown", transactionId: FIXED_TX_ID });
  });

  it("the SDK's timeout is TIMEOUT / unknown", async () => {
    const { error } = await failWith(request => {
      request.onTransactionId(FIXED_TX_ID);
      throw hederaError("MaxAttemptsOrTimeoutError", undefined, "max attempts of 10 was reached");
    });
    expect(error).toMatchObject({ code: "TIMEOUT", outcome: "unknown", retryable: true, transactionId: FIXED_TX_ID });
  });

  it("the publisher's own deadline is TIMEOUT / unknown, keeps the transaction id, and ignores the late outcome", async () => {
    const late = vi.fn();
    const { error, calls } = await failWith(
      request =>
        new Promise((_, reject) => {
          request.onTransactionId(FIXED_TX_ID);
          setTimeout(() => {
            late();
            reject(new Error("late failure after the deadline"));
          }, 60);
        }),
      makeConfig("testnet", { timeoutMs: 20 }),
    );
    expect(error).toMatchObject({ code: "TIMEOUT", outcome: "unknown", transactionId: FIXED_TX_ID });
    expect(error.message).toContain("20 ms");
    expect(calls).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 100)); // the late rejection must not surface as an unhandled rejection
    expect(late).toHaveBeenCalled();
  });

  it("a transaction refused by the network is TRANSACTION_FAILED / rejected, with the Hedera status", async () => {
    const { error } = await failWith(() => {
      throw hederaError("ReceiptStatusError", "INVALID_SIGNATURE");
    });
    expect(error).toMatchObject({ code: "TRANSACTION_FAILED", outcome: "rejected", hederaStatus: "INVALID_SIGNATURE" });
  });

  it("a normalized error thrown by the transport passes through", async () => {
    const { error } = await failWith(() => {
      throw new HcsPublishError({
        code: "TOPIC_NOT_WRITABLE",
        outcome: "not_sent",
        message: "m",
        remediation: "r",
        retryable: false,
      });
    });
    expect(error.code).toBe("TOPIC_NOT_WRITABLE");
  });

  it("a malformed success is UNEXPECTED_RESPONSE / unknown and keeps the transaction id", async () => {
    const { error } = await failWith(() => goodReceipt({ sequenceNumber: "" }));
    expect(error).toMatchObject({ code: "UNEXPECTED_RESPONSE", outcome: "unknown", transactionId: FIXED_TX_ID });
  });

  it("attaches the event identity to every failure so it can be correlated without the payload", async () => {
    const { error } = await failWith(() => {
      throw hederaError("PrecheckStatusError", "BUSY");
    });
    expect(error.eventKey).toBe("0xa443f61dfefa9b88087f5580a4365b62f4ff0f44b0cbd672d3323946ed6a27b8");
    expect(error.attestationDigest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("does not leak private keys or raw SDK text into results", async () => {
    const { result } = await failWith(() => {
      throw hederaError("PrecheckStatusError", "INVALID_TOPIC_ID", `operator key ${TEST_SIGNER_KEY} 302e020100`);
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain(TEST_SIGNER_KEY.slice(2));
    expect(text).not.toContain("302e020100");
  });

  it("never retries by itself, whatever the failure", async () => {
    for (const status of ["BUSY", "PLATFORM_NOT_ACTIVE", "INVALID_TOPIC_ID"]) {
      const { calls } = await failWith(() => {
        throw hederaError("PrecheckStatusError", status);
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("does not write to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(m =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    await failWith(() => {
      throw new Error("boom");
    });
    await createHcsPublisher(makeConfig(), fakeTransport(() => goodReceipt()).transport, options).publish(
      await input(),
    );
    expect(spies.every(spy => spy.mock.calls.length === 0)).toBe(true);
    spies.forEach(spy => spy.mockRestore());
  });
});

describe("idempotency at the door", () => {
  it("coalesces concurrent publications of the same attestation into one network call", async () => {
    let release: (receipt: ReturnType<typeof goodReceipt>) => void = () => undefined;
    const { transport, calls } = fakeTransport(() => new Promise(resolve => (release = resolve)));
    const publisher = createHcsPublisher(makeConfig(), transport, options);
    const payload = await input();
    const first = publisher.publish(payload);
    const second = publisher.publish(payload);
    await Promise.resolve();
    release(goodReceipt());
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it("does not coalesce different attestations, nor a later publication of the same one", async () => {
    const { transport, calls } = fakeTransport(() => goodReceipt());
    const publisher = createHcsPublisher(makeConfig(), transport, options);
    await Promise.all([
      publisher.publish(await input()),
      publisher.publish(await input({ observedAt: 1_767_225_100n })),
    ]);
    expect(calls).toHaveLength(2);
    await publisher.publish(await input());
    expect(calls).toHaveLength(3);
  });
});

describe("helpers", () => {
  it("converts transaction ids and timestamps", () => {
    expect(toMirrorTransactionId("0.0.2@1700000000.000000005")).toBe("0.0.2-1700000000-000000005");
    expect(toMirrorTransactionId("weird")).toBe("weird");
    expect(timestampToNanoseconds("1700000000.000000005")).toBe("1700000000000000005");
  });

  it("interpretReceipt rejects incomplete receipts", () => {
    expect(interpretReceipt(goodReceipt()).ok).toBe(true);
    for (const bad of [
      { sequenceNumber: "0" },
      { runningHash: "" },
      { runningHash: "xyz" },
      { consensusTimestamp: "1700000000" },
      { transactionId: "nope" },
    ]) {
      expect(interpretReceipt(goodReceipt(bad)).ok).toBe(false);
    }
  });

  it("unwrapPublish returns a success and throws a typed error for a failure", async () => {
    const ok = await createHcsPublisher(makeConfig(), fakeTransport(() => goodReceipt()).transport, options).publish(
      await input(),
    );
    expect(unwrapPublish(ok).status).toBe("published");
    const failed = await createHcsPublisher(
      makeConfig(),
      fakeTransport(() => {
        throw hederaError("MaxAttemptsOrTimeoutError");
      }).transport,
      options,
    ).publish(await input());
    expect(() => unwrapPublish(failed)).toThrow(HcsPublishError);
    try {
      unwrapPublish(failed);
    } catch (error) {
      expect((error as HcsPublishError).code).toBe("TIMEOUT");
    }
  });
});
