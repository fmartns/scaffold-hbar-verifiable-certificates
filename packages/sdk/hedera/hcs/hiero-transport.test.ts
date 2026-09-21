import { describe, expect, it } from "vitest";
import { PrivateKey } from "@hiero-ledger/sdk";
import { createHieroTransport, createHcsPublisherFromEnv, resolveKeyForAccount } from "./hiero-transport";
import { NETWORKS } from "../networks";
import type { HieroSdkLike, TopicMessageSubmitTransactionLike } from "./hiero-transport";
import { FIXED_TX_ID, validEnv } from "./test-fixtures";
import { HcsPublishError } from "./errors";

/** A fake of the parts of `TopicMessageSubmitTransaction` the adapter uses. */
function fakeSdk(behaviour: { executeError?: Error; recordError?: Error; noSequence?: boolean } = {}) {
  const trace: string[] = [];
  const state: {
    topicId?: string;
    message?: Uint8Array;
    regenerate?: boolean;
    maxAttempts?: number;
    deadline?: number;
    client?: unknown;
  } = {};
  class FakeTransaction implements TopicMessageSubmitTransactionLike {
    transactionId: { toString(): string } | null = null;
    setTopicId(id: string) {
      state.topicId = id;
      return this;
    }
    setMessage(message: Uint8Array) {
      state.message = message;
      return this;
    }
    setRegenerateTransactionId(regenerate: boolean) {
      state.regenerate = regenerate;
      return this;
    }
    setMaxAttempts(attempts: number) {
      state.maxAttempts = attempts;
      return this;
    }
    setGrpcDeadline(ms: number) {
      state.deadline = ms;
      return this;
    }
    freezeWith(client: unknown) {
      trace.push("freeze");
      state.client = client;
      this.transactionId = { toString: () => FIXED_TX_ID };
      return this;
    }
    async execute() {
      trace.push("execute");
      if (behaviour.executeError) throw behaviour.executeError;
      return {
        transactionId: { toString: () => FIXED_TX_ID },
        async getRecord() {
          trace.push("record");
          if (behaviour.recordError) throw behaviour.recordError;
          return {
            transactionId: { toString: () => FIXED_TX_ID },
            consensusTimestamp: { seconds: { toString: () => "1767225605" }, nanos: { toString: () => "42" } },
            receipt: {
              topicSequenceNumber: behaviour.noSequence ? null : { toString: () => "17" },
              topicRunningHash: new Uint8Array([0xde, 0xad, 0x01]),
            },
          };
        },
      };
    }
  }
  const sdk: HieroSdkLike = { TopicMessageSubmitTransaction: FakeTransaction };
  return { sdk, state, trace };
}

const request = (ids: string[] = []) => ({
  topicId: "0.0.4567",
  message: new Uint8Array([1, 2, 3]),
  timeoutMs: 30_000,
  onTransactionId: (id: string) => ids.push(id),
});

describe("createHieroTransport", () => {
  it("submits one message to the topic and maps the receipt and record", async () => {
    const { sdk, state } = fakeSdk();
    const client = { fake: "client" };
    const ids: string[] = [];
    const receipt = await createHieroTransport({ client, sdk }).submit(request(ids));

    expect(state).toMatchObject({ topicId: "0.0.4567", client });
    expect(Array.from(state.message ?? [])).toEqual([1, 2, 3]);
    expect(receipt).toEqual({
      transactionId: FIXED_TX_ID,
      sequenceNumber: "17",
      runningHash: "dead01",
      consensusTimestamp: "1767225605.000000042", // nanos are left-padded to 9 digits
    });
    expect(ids[0]).toBe(FIXED_TX_ID);
  });

  it("never regenerates the transaction id, so SDK-internal retries cannot create a second message", async () => {
    const { sdk, state } = fakeSdk();
    await createHieroTransport({ client: {}, sdk }).submit(request());
    expect(state.regenerate).toBe(false);
    expect(state.maxAttempts).toBe(3);
    expect(state.deadline).toBe(15_000);
  });

  it("reports the transaction id before sending, so a failed send can still be correlated", async () => {
    const { sdk, trace } = fakeSdk({ executeError: new Error("connect ECONNREFUSED") });
    const ids: string[] = [];
    await expect(createHieroTransport({ client: {}, sdk }).submit(request(ids))).rejects.toThrow();
    expect(ids).toEqual([FIXED_TX_ID]);
    expect(trace).toEqual(["freeze", "execute"]);
  });

  it("propagates record errors untouched for the publisher to classify", async () => {
    const boom = Object.assign(new Error("receipt failed"), { name: "ReceiptStatusError" });
    const { sdk } = fakeSdk({ recordError: boom });
    await expect(createHieroTransport({ client: {}, sdk }).submit(request())).rejects.toBe(boom);
  });

  it("returns an empty sequence when the receipt lacks one, which the publisher rejects", async () => {
    const { sdk } = fakeSdk({ noSequence: true });
    expect((await createHieroTransport({ client: {}, sdk }).submit(request())).sequenceNumber).toBe("");
  });
});

describe("createHcsPublisherFromEnv", () => {
  it("fails with CONFIG_INVALID before creating any client when the HCS configuration is missing", async () => {
    await expect(createHcsPublisherFromEnv({})).rejects.toBeInstanceOf(HcsPublishError);
  });

  it("fails with CONFIG_INVALID when the operator account is missing, without echoing the key", async () => {
    const error = await createHcsPublisherFromEnv(validEnv({ HEDERA_OPERATOR_KEY: "cd".repeat(32) })).catch(e => e);
    expect(error).toBeInstanceOf(HcsPublishError);
    expect(error.code).toBe("CONFIG_INVALID");
    expect(JSON.stringify(error.failure)).not.toContain("cdcdcd");
  });

  it("rejects a key that is not hex without echoing it", async () => {
    const error = await createHcsPublisherFromEnv(
      validEnv({ HEDERA_OPERATOR_ID: "0.0.1234", HEDERA_OPERATOR_KEY: "not-a-key-SECRET" }),
    ).catch(e => e);
    expect(error.code).toBe("CONFIG_INVALID");
    expect(JSON.stringify(error.failure)).not.toContain("SECRET");
  });

  it("uses an injected transport without creating a client (no network, no key needed)", async () => {
    const { transport } = {
      transport: {
        submit: async () => {
          throw new Error("unused");
        },
      },
    };
    const handle = await createHcsPublisherFromEnv(validEnv(), { transport });
    expect(handle.publisher.topicId).toBe("0.0.4567");
    handle.close();
    handle.close();
  });
});

// A real ED25519 and a real ECDSA keypair (generated once with @hiero-ledger/sdk), so `inspectPrivateKey` (used inside
// `resolveKeyForAccount`) derives real, matching candidates instead of needing a fake.
const REAL_ED25519_RAW = "4648e9a7526ef8e01ec5c7d4cd2096da120921b34daf46523301282832d0248b";
const REAL_ED25519_PUBLIC = "2e37d27345eaa7ca6256b6acb4f46752603ae0557abcfb20f283e4e5490512d6";
const REAL_ECDSA_RAW = "5f61c88cfd65a05f976c77171b6f8d22aa0cda47b920b741f25c4459820ed9fa";
const REAL_ECDSA_PUBLIC = "0354e14b90b63378f4d65bc4f8a65fdb1b658d7d5126aa874e9f49457d2f2e5729";

describe("resolveKeyForAccount", () => {
  const account = (publicKey: string, type = "ED25519") =>
    (async () =>
      new Response(
        `{"account":"0.0.9001","deleted":false,"balance":{"balance":0,"timestamp":"1.0","tokens":[]},"key":{"_type":"${type}","key":"${publicKey}"}}`,
      )) as typeof fetch;

  it("resolves a raw key against the ED25519 or ECDSA public key the account actually has", async () => {
    const ed = await resolveKeyForAccount(
      REAL_ED25519_RAW,
      "0.0.9001",
      NETWORKS.testnet,
      { PrivateKey },
      account(REAL_ED25519_PUBLIC),
      "MY_KEY",
    );
    expect((ed as { toStringRaw(): string }).toStringRaw()).toBe(REAL_ED25519_RAW);
    const ecdsa = await resolveKeyForAccount(
      REAL_ECDSA_RAW,
      "0.0.9001",
      NETWORKS.testnet,
      { PrivateKey },
      account(REAL_ECDSA_PUBLIC, "ECDSA_SECP256K1"),
      "MY_KEY",
    );
    expect((ecdsa as { toStringRaw(): string }).toStringRaw()).toBe(REAL_ECDSA_RAW);
  });

  it("resolves a DER-encoded key without any network lookup (it carries its own curve)", async () => {
    const der = PrivateKey.fromStringED25519(REAL_ED25519_RAW).toStringDer();
    const calls: string[] = [];
    const key = await resolveKeyForAccount(
      der,
      "0.0.9001",
      NETWORKS.testnet,
      { PrivateKey },
      (async (i: RequestInfo | URL) => (calls.push(String(i)), account(REAL_ED25519_PUBLIC)(i))) as never,
      "MY_KEY",
    );
    expect((key as { toStringRaw(): string }).toStringRaw()).toBe(REAL_ED25519_RAW);
    expect(calls).toHaveLength(0);
  });

  it("fails, naming the given variable, when the key does not match the account", async () => {
    const error = await resolveKeyForAccount(
      REAL_ED25519_RAW,
      "0.0.9001",
      NETWORKS.testnet,
      { PrivateKey },
      account(REAL_ECDSA_PUBLIC, "ECDSA_SECP256K1"),
      "MY_KEY",
    )
      .then(() => null)
      .catch((e: unknown) => e as HcsPublishError);
    expect(error).toBeInstanceOf(HcsPublishError);
    expect(error!.failure).toMatchObject({ code: "CONFIG_INVALID" });
    expect(error!.failure.message).toContain("MY_KEY");
    expect(error!.failure.message).toContain("0.0.9001");
  });

  it("rejects a non-hex value without echoing it", async () => {
    const error = await resolveKeyForAccount(
      "not-a-key-SECRET",
      "0.0.9001",
      NETWORKS.testnet,
      { PrivateKey },
      account(REAL_ED25519_PUBLIC),
      "MY_KEY",
    )
      .then(() => null)
      .catch((e: unknown) => e as HcsPublishError);
    expect(error!.failure.message).not.toContain("SECRET");
    expect(error!.failure.message).toContain("MY_KEY");
  });

  it("never echoes the key in the mismatch error either", async () => {
    const error = await resolveKeyForAccount(
      REAL_ED25519_RAW,
      "0.0.9001",
      NETWORKS.testnet,
      { PrivateKey },
      account(REAL_ECDSA_PUBLIC, "ECDSA_SECP256K1"),
      "MY_KEY",
    )
      .then(() => null)
      .catch((e: unknown) => e as HcsPublishError);
    expect(JSON.stringify(error!.failure)).not.toContain(REAL_ED25519_RAW);
  });
});
