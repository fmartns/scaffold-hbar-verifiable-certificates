import { describe, expect, it } from "vitest";
import { NETWORKS } from "../networks";
import { preflightHcsPublisher, verifyHcsTopic } from "./topic-check";
import { TEST_TOPIC, validEnv } from "./test-fixtures";

const PUBLISHER_KEY = "ab".repeat(32);
const publisherKeys = [{ type: "ED25519", publicKey: PUBLISHER_KEY }];
const OPERATOR = "0.0.1234";

type Topic = { status?: number; body?: Record<string, unknown>; down?: boolean };

/** In-memory Mirror Node: one topic and one account. */
function fakeMirror({ topic = {}, accountKey = PUBLISHER_KEY }: { topic?: Topic; accountKey?: string } = {}) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname.startsWith("/api/v1/topics/")) {
      if (topic.down) throw new Error("connect ECONNREFUSED");
      if (topic.status) return new Response("", { status: topic.status });
      return new Response(
        JSON.stringify({
          topic_id: TEST_TOPIC,
          memo: "evidence",
          deleted: false,
          submit_key: { _type: "ED25519", key: PUBLISHER_KEY },
          ...topic.body,
        }),
      );
    }
    if (url.pathname.startsWith("/api/v1/accounts/")) {
      return new Response(
        `{"account":"${OPERATOR}","deleted":false,"balance":{"balance":100000000000,"timestamp":"1.0","tokens":[]},"key":{"_type":"ED25519","key":"${accountKey}"}}`,
      );
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

const check = (mirror: ReturnType<typeof fakeMirror>) =>
  verifyHcsTopic(NETWORKS.testnet, TEST_TOPIC, { fetch: mirror.impl, publisherKeys });

describe("verifyHcsTopic", () => {
  it("accepts a topic whose submitKey is the publisher key", async () => {
    const result = await check(fakeMirror());
    expect(result).toMatchObject({
      ok: true,
      topic: { topicId: TEST_TOPIC, deleted: false, submitKey: { type: "ED25519", key: PUBLISHER_KEY } },
    });
  });

  it("queries the configured network's Mirror Node", async () => {
    const calls: string[] = [];
    await verifyHcsTopic(NETWORKS.mainnet, "0.0.9", {
      publisherKeys,
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response("", { status: 404 });
      }) as typeof fetch,
    });
    expect(calls).toEqual(["https://mainnet.mirrornode.hedera.com/api/v1/topics/0.0.9"]);
  });

  it("reports a nonexistent topic as TOPIC_INVALID", async () => {
    const result = await check(fakeMirror({ topic: { status: 404 } }));
    expect(result).toMatchObject({ ok: false, error: { code: "TOPIC_INVALID", outcome: "not_sent" } });
  });

  it("reports a non-JSON answer as a retryable failure instead of throwing", async () => {
    const result = await verifyHcsTopic(NETWORKS.testnet, TEST_TOPIC, {
      publisherKeys,
      fetch: (async () => new Response("<html>proxy error</html>")) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "NETWORK_UNAVAILABLE", retryable: true } });
  });

  it("reports a deleted topic as TOPIC_INVALID", async () => {
    const result = await check(fakeMirror({ topic: { body: { deleted: true } } }));
    expect(result).toMatchObject({ ok: false, error: { code: "TOPIC_INVALID" } });
  });

  it("reports a topic without submitKey as TOPIC_NOT_WRITABLE (ADR P5)", async () => {
    const result = await check(fakeMirror({ topic: { body: { submit_key: null } } }));
    expect(result).toMatchObject({ ok: false, error: { code: "TOPIC_NOT_WRITABLE" } });
    if (!result.ok) expect(result.error.message).toMatch(/anyone could write/);
  });

  it("reports another key as TOPIC_NOT_WRITABLE", async () => {
    const result = await check(
      fakeMirror({ topic: { body: { submit_key: { _type: "ED25519", key: "cd".repeat(32) } } } }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "TOPIC_NOT_WRITABLE" } });
  });

  it("does not claim a complex key (key list, threshold) is satisfied by one operator key", async () => {
    const result = await check(
      fakeMirror({ topic: { body: { submit_key: { _type: "ProtobufEncoded", key: PUBLISHER_KEY } } } }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "TOPIC_NOT_WRITABLE" } });
  });

  it("distinguishes an unreachable Mirror Node and an HTTP error, both retryable", async () => {
    expect(await check(fakeMirror({ topic: { down: true } }))).toMatchObject({
      ok: false,
      error: { code: "NETWORK_UNAVAILABLE", retryable: true },
    });
    expect(await check(fakeMirror({ topic: { status: 503 } }))).toMatchObject({
      ok: false,
      error: { code: "NETWORK_UNAVAILABLE", retryable: true },
    });
  });
});

describe("preflightHcsPublisher (reuses the environment validator of #5)", () => {
  const env = (extra: Record<string, string> = {}) =>
    validEnv({ HEDERA_OPERATOR_ID: OPERATOR, HEDERA_OPERATOR_KEY: "ef".repeat(32), ...extra });
  const inspectKey = async () => [{ type: "ED25519" as const, publicKey: PUBLISHER_KEY }];

  it("passes when the environment, the configuration and the topic are valid", async () => {
    const mirror = fakeMirror();
    const result = await preflightHcsPublisher(env(), { fetch: mirror.impl, inspectKey });
    expect(result).toMatchObject({ ok: true, config: { topicId: TEST_TOPIC }, topic: { topicId: TEST_TOPIC } });
    expect(mirror.calls.some(c => c.startsWith("/api/v1/accounts/"))).toBe(true);
    expect(mirror.calls.some(c => c.startsWith("/api/v1/topics/"))).toBe(true);
  });

  it("stops at an invalid configuration without any request", async () => {
    const mirror = fakeMirror();
    const result = await preflightHcsPublisher(env({ HEDERA_HCS_TOPIC_ID: "" }), { fetch: mirror.impl, inspectKey });
    expect(result).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
    expect(mirror.calls).toHaveLength(0);
  });

  it("surfaces an invalid Hedera environment (#5) as CONFIG_INVALID with its remediation", async () => {
    const result = await preflightHcsPublisher(env({ HEDERA_OPERATOR_ID: "" }), {
      fetch: fakeMirror().impl,
      inspectKey,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID", retryable: false } });
    if (!result.ok) expect(result.error.message).toMatch(/MISSING_ENV/);
  });

  it("does not put the operator key in any failure", async () => {
    const result = await preflightHcsPublisher(
      env({ HEDERA_OPERATOR_KEY: "ef".repeat(32), HEDERA_HCS_TOPIC_ID: "bad" }),
      {
        fetch: fakeMirror().impl,
        inspectKey,
      },
    );
    expect(JSON.stringify(result)).not.toContain("ef".repeat(8));
  });

  it("fails when the topic is not writable by the operator", async () => {
    const mirror = fakeMirror({ topic: { body: { submit_key: null } } });
    expect(await preflightHcsPublisher(env(), { fetch: mirror.impl, inspectKey })).toMatchObject({
      ok: false,
      error: { code: "TOPIC_NOT_WRITABLE" },
    });
  });

  it("reports an unreachable network as retryable, not as a configuration error", async () => {
    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    const result = await preflightHcsPublisher(env(), { fetch: down, inspectKey });
    expect(result).toMatchObject({ ok: false, error: { code: "NETWORK_UNAVAILABLE", retryable: true } });
  });
});
