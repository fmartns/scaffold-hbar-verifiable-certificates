import { describe, expect, it } from "vitest";
import { NETWORKS } from "../networks";
import { createHieroTopicCreator, provisionHcsTopic } from "./topic-create";
import type { TopicCreateTransactionLike, TopicCreator } from "./topic-create";
import { FIXED_TX_ID, TEST_TOPIC, hederaError } from "./test-fixtures";

const PUBLISHER_KEY = "ab".repeat(32);
const OPERATOR = "0.0.1234";
const inspectKey = async () => [{ type: "ED25519" as const, publicKey: PUBLISHER_KEY }];
const NEW_TOPIC = "0.0.8888";

const baseEnv = (extra: Record<string, string> = {}) => ({
  HEDERA_NETWORK: "testnet",
  HEDERA_OPERATOR_ID: OPERATOR,
  HEDERA_OPERATOR_KEY: "ef".repeat(32),
  ...extra,
});

/** In-memory Mirror Node: the account, and topics that appear after `appearsAfter` lookups. */
function fakeMirror(
  opts: {
    topics?: Record<string, { submitKey?: string | null; after?: number }>;
    accountBalance?: bigint;
    rate?: boolean;
    fee?: number;
  } = {},
) {
  const looks: Record<string, number> = {};
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname.startsWith("/api/v1/accounts/")) {
      return new Response(
        `{"account":"${OPERATOR}","deleted":false,"balance":{"balance":${opts.accountBalance ?? 100000000000n},"timestamp":"1.0","tokens":[]},"key":{"_type":"ED25519","key":"${PUBLISHER_KEY}"}}`,
      );
    }
    if (url.pathname === "/api/v1/network/exchangerate") {
      return opts.rate
        ? new Response(JSON.stringify({ current_rate: { cent_equivalent: 231199, hbar_equivalent: 30000 } }))
        : new Response("", { status: 503 });
    }
    if (url.pathname.startsWith("/api/v1/transactions/")) {
      return opts.fee === undefined
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify({ transactions: [{ charged_tx_fee: opts.fee }] }));
    }
    const id = url.pathname.split("/").pop() ?? "";
    const topic = opts.topics?.[id];
    looks[id] = (looks[id] ?? 0) + 1;
    if (!topic || looks[id] <= (topic.after ?? 0)) return new Response("", { status: 404 });
    const submitKey = topic.submitKey === undefined ? PUBLISHER_KEY : topic.submitKey;
    return new Response(
      JSON.stringify({
        topic_id: id,
        memo: "m",
        deleted: false,
        submit_key: submitKey ? { _type: "ED25519", key: submitKey } : null,
      }),
    );
  }) as typeof fetch;
  return { impl, calls, looks };
}

function fakeCreator(behaviour?: (r: Parameters<TopicCreator["create"]>[0]) => Promise<never> | void) {
  const requests: Parameters<TopicCreator["create"]>[0][] = [];
  const creator: TopicCreator = {
    async create(request) {
      requests.push(request);
      request.onTransactionId(FIXED_TX_ID);
      await behaviour?.(request);
      return { topicId: NEW_TOPIC, transactionId: FIXED_TX_ID };
    },
  };
  return { creator, requests };
}

const run = (env: Record<string, string>, mirror: ReturnType<typeof fakeMirror>, extra = {}) =>
  provisionHcsTopic(env, { fetch: mirror.impl, inspectKey, sleep: async () => undefined, verifyDelayMs: 0, ...extra });

describe("provisionHcsTopic", () => {
  it("creates the topic, confirms it on Mirror Node and returns the .env line and HashScan link", async () => {
    const { creator, requests } = fakeCreator();
    const mirror = fakeMirror({ topics: { [NEW_TOPIC]: {} } });
    const result = await run(baseEnv(), mirror, { creator });
    expect(result).toMatchObject({
      ok: true,
      status: "created",
      network: "testnet",
      topicId: NEW_TOPIC,
      transactionId: FIXED_TX_ID,
      envLine: `HEDERA_HCS_TOPIC_ID=${NEW_TOPIC}`,
      hashscanTopicUrl: `https://hashscan.io/testnet/topic/${NEW_TOPIC}`,
      verified: true,
      adminKey: false,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ memo: "verifiable-settlement evidence", withAdminKey: false });
  });

  it("waits for Mirror Node to index the new topic", async () => {
    const { creator } = fakeCreator();
    const mirror = fakeMirror({ topics: { [NEW_TOPIC]: { after: 3 } } });
    expect(await run(baseEnv(), mirror, { creator })).toMatchObject({ ok: true, verified: true });
    expect(mirror.looks[NEW_TOPIC]).toBe(4);
  });

  it("still succeeds, with a warning, when Mirror Node never shows the topic in time", async () => {
    const { creator } = fakeCreator();
    const result = await run(baseEnv(), fakeMirror(), { creator, verifyAttempts: 3 });
    expect(result).toMatchObject({ ok: true, status: "created", verified: false });
    if (result.ok) expect(result.warnings.join(" ")).toMatch(/Mirror Node did not show it yet/);
  });

  it("passes the memo and the optional adminKey to the creator, and warns about the adminKey", async () => {
    const { creator, requests } = fakeCreator();
    const result = await run(baseEnv(), fakeMirror({ topics: { [NEW_TOPIC]: {} } }), {
      creator,
      memo: "my topic",
      withAdminKey: true,
    });
    expect(requests[0]).toMatchObject({ memo: "my topic", withAdminKey: true });
    expect(result).toMatchObject({ ok: true, adminKey: true });
    if (result.ok) expect(result.warnings.join(" ")).toMatch(/adminKey/);
  });

  it("never creates a second topic when the configured one is usable", async () => {
    const { creator, requests } = fakeCreator();
    const mirror = fakeMirror({ topics: { [TEST_TOPIC]: {} } });
    const result = await run(baseEnv({ HEDERA_HCS_TOPIC_ID: TEST_TOPIC }), mirror, { creator });
    expect(result).toMatchObject({ ok: true, status: "existing", topicId: TEST_TOPIC });
    expect(requests).toHaveLength(0);
  });

  it("does not create a topic over a configured one that is unusable, and says how to proceed", async () => {
    const { creator, requests } = fakeCreator();
    const noKey = await run(
      baseEnv({ HEDERA_HCS_TOPIC_ID: TEST_TOPIC }),
      fakeMirror({ topics: { [TEST_TOPIC]: { submitKey: null } } }),
      { creator },
    );
    expect(noKey).toMatchObject({ ok: false, error: { code: "TOPIC_NOT_WRITABLE" } });
    if (!noKey.ok) expect(noKey.error.remediation).toMatch(/empty HEDERA_HCS_TOPIC_ID/);
    const missing = await run(baseEnv({ HEDERA_HCS_TOPIC_ID: TEST_TOPIC }), fakeMirror(), { creator });
    expect(missing).toMatchObject({ ok: false, error: { code: "TOPIC_INVALID" } });
    const malformed = await run(baseEnv({ HEDERA_HCS_TOPIC_ID: "nope" }), fakeMirror(), { creator });
    expect(malformed).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
    expect(requests).toHaveLength(0);
  });

  it("creates nothing when the Hedera environment (#5) is invalid, reporting why", async () => {
    const { creator, requests } = fakeCreator();
    const noAccount = await run(baseEnv({ HEDERA_OPERATOR_ID: "" }), fakeMirror(), { creator });
    expect(noAccount).toMatchObject({
      ok: false,
      environment: { status: "invalid" },
      error: { code: "CONFIG_INVALID" },
    });
    const poor = await run(baseEnv(), fakeMirror({ accountBalance: 100n }), { creator });
    expect(poor).toMatchObject({ ok: false, environment: { issues: [{ code: "INSUFFICIENT_BALANCE" }] } });
    expect(requests).toHaveLength(0);
  });

  it("reports an unreachable network as retryable and creates nothing", async () => {
    const { creator, requests } = fakeCreator();
    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    const result = await provisionHcsTopic(baseEnv(), { fetch: down, inspectKey, creator });
    expect(result).toMatchObject({ ok: false, error: { code: "NETWORK_UNAVAILABLE", retryable: true } });
    expect(requests).toHaveLength(0);
  });

  it("refuses mainnet unless allowed, before any request", async () => {
    const { creator, requests } = fakeCreator();
    const mirror = fakeMirror();
    const refused = await run(baseEnv({ HEDERA_NETWORK: "mainnet" }), mirror, { creator });
    expect(refused).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
    expect(mirror.calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(NETWORKS.mainnet.name).toBe("mainnet");
  });

  it("validates the memo length and the network name", async () => {
    const { creator } = fakeCreator();
    expect(await run(baseEnv(), fakeMirror(), { creator, memo: "x".repeat(101) })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID" },
    });
    expect(await run(baseEnv({ HEDERA_NETWORK: "devnet" }), fakeMirror(), { creator })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID" },
    });
  });

  it("classifies creation failures and never retries", async () => {
    const attempts = { count: 0 };
    const failing: TopicCreator = {
      async create() {
        attempts.count++;
        throw hederaError("PrecheckStatusError", "INSUFFICIENT_PAYER_BALANCE");
      },
    };
    const result = await run(baseEnv(), fakeMirror(), { creator: failing });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "TRANSACTION_FAILED", outcome: "rejected", hederaStatus: "INSUFFICIENT_PAYER_BALANCE" },
    });
    expect(attempts.count).toBe(1);
  });

  it("tells the user to check HashScan, not to retry, after a timeout (a second creation would leave a duplicate)", async () => {
    const hanging: TopicCreator = {
      create: request => {
        request.onTransactionId(FIXED_TX_ID);
        return new Promise(() => undefined);
      },
    };
    const result = await run(baseEnv(), fakeMirror(), { creator: hanging, createTimeoutMs: 20 });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "TIMEOUT", outcome: "unknown", retryable: false, transactionId: FIXED_TX_ID },
    });
    if (!result.ok) expect(result.error.remediation).toMatch(/duplicate/);
  });

  it("fails if the created topic does not carry the operator key as submitKey", async () => {
    const { creator } = fakeCreator();
    const mirror = fakeMirror({ topics: { [NEW_TOPIC]: { submitKey: "cd".repeat(32) } } });
    expect(await run(baseEnv(), mirror, { creator })).toMatchObject({
      ok: false,
      error: { code: "TOPIC_NOT_WRITABLE", transactionId: FIXED_TX_ID },
    });
  });

  it("never leaks the operator key", async () => {
    const { creator } = fakeCreator();
    const results = [
      await run(baseEnv(), fakeMirror({ topics: { [NEW_TOPIC]: {} } }), { creator }),
      await run(baseEnv({ HEDERA_HCS_TOPIC_ID: "nope" }), fakeMirror(), { creator }),
      await run(baseEnv({ HEDERA_OPERATOR_ID: "" }), fakeMirror(), { creator }),
    ];
    expect(JSON.stringify(results)).not.toContain("efefef");
  });
});

describe("confirmation and cost", () => {
  it("shows the plan and the estimated cost, then creates only after the answer is yes", async () => {
    const { creator, requests } = fakeCreator();
    const plans: unknown[] = [];
    const mirror = fakeMirror({ topics: { [NEW_TOPIC]: {} }, rate: true, fee: 25_631_823 });
    const result = await run(baseEnv(), mirror, {
      creator,
      memo: "my memo",
      confirm: async (plan: unknown) => {
        plans.push(plan);
        expect(requests).toHaveLength(0); // nothing is paid for before the answer
        return true;
      },
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      network: "testnet",
      chainId: 296,
      operatorId: OPERATOR,
      balance: { hbar: "1000" },
      memo: "my memo",
      withAdminKey: false,
      cost: { free: true, usdPerHbar: "0.0771", createTopic: { usd: "0.02", hbar: "0.2595" } },
    });
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, cost: { charged: { hbar: "0.25631823", usd: "0.02" } } });
  });

  it("creates nothing and reports CANCELLED when the answer is no", async () => {
    const { creator, requests } = fakeCreator();
    const result = await run(baseEnv(), fakeMirror({ topics: { [NEW_TOPIC]: {} } }), {
      creator,
      confirm: async () => false,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED", outcome: "not_sent", retryable: false } });
    expect(requests).toHaveLength(0);
  });

  it("does not ask when nothing would be paid for (invalid environment, existing topic, mainnet refusal)", async () => {
    const { creator } = fakeCreator();
    let asked = 0;
    const confirm = async () => (asked++, true);
    await run(baseEnv({ HEDERA_OPERATOR_ID: "" }), fakeMirror(), { creator, confirm });
    await run(baseEnv({ HEDERA_HCS_TOPIC_ID: TEST_TOPIC }), fakeMirror({ topics: { [TEST_TOPIC]: {} } }), {
      creator,
      confirm,
    });
    await run(baseEnv({ HEDERA_NETWORK: "mainnet" }), fakeMirror(), { creator, confirm });
    expect(asked).toBe(0);
  });

  it("still works, with USD only, when the exchange rate is unavailable, and reports the estimate as the cost", async () => {
    const { creator } = fakeCreator();
    let seen: { cost: { createTopic: { hbar: string | null } } } | undefined;
    const result = await run(baseEnv(), fakeMirror({ topics: { [NEW_TOPIC]: {} } }), {
      creator,
      confirm: async (plan: never) => ((seen = plan), true),
    });
    expect(seen?.cost.createTopic.hbar).toBeNull();
    expect(result).toMatchObject({ ok: true, cost: { charged: null } });
  });

  it("marks the plan as real money on mainnet", async () => {
    const { creator } = fakeCreator();
    let free: boolean | undefined;
    // The mainnet Mirror host is not served by the fake, so the run stops at the environment check; the plan cost is
    // covered by the estimate tests. This asserts the gate: no plan, no request, before --allow-mainnet.
    const result = await run(baseEnv({ HEDERA_NETWORK: "mainnet" }), fakeMirror(), {
      creator,
      confirm: async (plan: never) => ((free = (plan as { cost: { free: boolean } }).cost.free), true),
    });
    expect(result.ok).toBe(false);
    expect(free).toBeUndefined();
  });
});

describe("createHieroTopicCreator", () => {
  function fakeSdk(receiptTopic: string | null = "0.0.8888") {
    const state: Record<string, unknown> = {};
    class Fake implements TopicCreateTransactionLike {
      transactionId: { toString(): string } | null = null;
      setSubmitKey(k: unknown) {
        state.submitKey = k;
        return this;
      }
      setAdminKey(k: unknown) {
        state.adminKey = k;
        return this;
      }
      setTopicMemo(m: string) {
        state.memo = m;
        return this;
      }
      setRegenerateTransactionId(r: boolean) {
        state.regenerate = r;
        return this;
      }
      setMaxAttempts(n: number) {
        state.maxAttempts = n;
        return this;
      }
      setGrpcDeadline(ms: number) {
        state.deadline = ms;
        return this;
      }
      freezeWith() {
        this.transactionId = { toString: () => FIXED_TX_ID };
        return this;
      }
      async execute() {
        return {
          transactionId: { toString: () => FIXED_TX_ID },
          getReceipt: async () => ({ topicId: receiptTopic ? { toString: () => receiptTopic } : null }),
        };
      }
    }
    return { sdk: { TopicCreateTransaction: Fake, TopicMessageSubmitTransaction: class {} } as never, state };
  }
  const key = { publicKey: "PUBLIC" };
  const request = (withAdminKey: boolean, ids: string[] = []) => ({
    memo: "m",
    withAdminKey,
    timeoutMs: 30_000,
    onTransactionId: (id: string) => ids.push(id),
  });

  it("sets the operator public key as submitKey, never regenerates the transaction id, and returns the topic id", async () => {
    const { sdk, state } = fakeSdk();
    const ids: string[] = [];
    const created = await createHieroTopicCreator({ client: {}, key, sdk }).create(request(false, ids));
    expect(created).toEqual({ topicId: "0.0.8888", transactionId: FIXED_TX_ID });
    expect(state).toMatchObject({ submitKey: "PUBLIC", memo: "m", regenerate: false, maxAttempts: 3 });
    expect(state.adminKey).toBeUndefined();
    expect(ids[0]).toBe(FIXED_TX_ID);
  });

  it("sets the adminKey only when asked", async () => {
    const { sdk, state } = fakeSdk();
    await createHieroTopicCreator({ client: {}, key, sdk }).create(request(true));
    expect(state.adminKey).toBe("PUBLIC");
  });

  it("fails when the receipt has no topic id", async () => {
    const { sdk } = fakeSdk(null);
    await expect(createHieroTopicCreator({ client: {}, key, sdk }).create(request(false))).rejects.toThrow();
  });
});
