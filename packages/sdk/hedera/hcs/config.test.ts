import { describe, expect, it } from "vitest";
import { DEFAULT_PUBLISH_TIMEOUT_MS, HCS_ENV, isValidTopicId, loadHcsPublisherConfig } from "./config";
import { HcsPublishError } from "./errors";
import { TEST_ROUTER, TEST_TOPIC, validEnv } from "./test-fixtures";

function failureOf(env: Record<string, string | undefined>) {
  try {
    loadHcsPublisherConfig(env);
  } catch (error) {
    if (error instanceof HcsPublishError) return error.failure;
    throw error;
  }
  throw new Error("expected CONFIG_INVALID");
}

describe("loadHcsPublisherConfig", () => {
  it("reads the topic and router from the environment (nothing hardcoded)", () => {
    const a = loadHcsPublisherConfig(validEnv());
    const b = loadHcsPublisherConfig(validEnv({ HEDERA_HCS_TOPIC_ID: "0.0.999" }));
    expect(a).toMatchObject({ topicId: TEST_TOPIC, routerAddress: TEST_ROUTER, timeoutMs: DEFAULT_PUBLISH_TIMEOUT_MS });
    expect(b.topicId).toBe("0.0.999");
  });

  it("defaults to testnet and follows HEDERA_NETWORK", () => {
    expect(loadHcsPublisherConfig({ ...validEnv(), HEDERA_NETWORK: "" }).network.name).toBe("testnet");
    expect(loadHcsPublisherConfig(validEnv({ HEDERA_NETWORK: "mainnet" })).network.chainId).toBe(295);
  });

  it("normalizes the router address and accepts a valid checksum", () => {
    const config = loadHcsPublisherConfig(
      validEnv({ HEDERA_SETTLEMENT_ROUTER_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3" }),
    );
    expect(config.routerAddress).toBe(TEST_ROUTER);
  });

  it("accepts a valid timeout override", () => {
    expect(loadHcsPublisherConfig(validEnv({ [HCS_ENV.PUBLISH_TIMEOUT_MS]: "5000" })).timeoutMs).toBe(5000);
  });

  it("reports every missing variable at once as CONFIG_INVALID with remediation", () => {
    const failure = failureOf({});
    expect(failure).toMatchObject({ code: "CONFIG_INVALID", outcome: "not_sent", retryable: false });
    expect(failure.configIssues?.map(i => i.variable)).toEqual([HCS_ENV.TOPIC_ID, HCS_ENV.ROUTER_ADDRESS]);
    expect(failure.remediation).toMatch(/submitKey/);
  });

  it.each([
    [{ HEDERA_HCS_TOPIC_ID: "abc" }, HCS_ENV.TOPIC_ID],
    [{ HEDERA_HCS_TOPIC_ID: "0.0.0" }, HCS_ENV.TOPIC_ID],
    [{ HEDERA_HCS_TOPIC_ID: "0.0.12x" }, HCS_ENV.TOPIC_ID],
    [{ HEDERA_SETTLEMENT_ROUTER_ADDRESS: "0x1234" }, HCS_ENV.ROUTER_ADDRESS],
    [{ HEDERA_SETTLEMENT_ROUTER_ADDRESS: "0x0000000000000000000000000000000000000000" }, HCS_ENV.ROUTER_ADDRESS],
    [{ HEDERA_HCS_PUBLISH_TIMEOUT_MS: "5" }, HCS_ENV.PUBLISH_TIMEOUT_MS],
    [{ HEDERA_HCS_PUBLISH_TIMEOUT_MS: "fast" }, HCS_ENV.PUBLISH_TIMEOUT_MS],
    [{ HEDERA_NETWORK: "devnet" }, "HEDERA_NETWORK"],
  ])("rejects %j", (override, variable) => {
    expect(failureOf(validEnv(override)).configIssues?.map(i => i.variable)).toContain(variable);
  });

  it("never echoes secrets from the environment", () => {
    const failure = failureOf({
      HEDERA_OPERATOR_KEY: "302e020100300506032b657004220420aabbccdd",
      HEDERA_HCS_TOPIC_ID: "nope",
    });
    expect(JSON.stringify(failure)).not.toContain("aabbccdd");
  });
});

describe("isValidTopicId", () => {
  it("accepts shard.realm.num and rejects the rest", () => {
    expect(isValidTopicId("0.0.4567")).toBe(true);
    expect(isValidTopicId("1.2.3")).toBe(true);
    expect(["", "0.0", "0.0.0", "a.b.c", "0.0.1.2", "0.0.-1"].some(isValidTopicId)).toBe(false);
  });
});
