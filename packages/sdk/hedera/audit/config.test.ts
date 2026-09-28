import { describe, expect, it } from "vitest";
import { auditCredential } from "./audit";
import { CredentialAuditConfigError, createCredentialAuditContext, loadCredentialAuditConfig } from "./config";
import { CREDENTIAL_ID, REGISTRY, TOPIC, consistentWorld, fakeFetch, virtualClock, REVOKED_AT } from "./test-fixtures";

const env = (extra: Record<string, string> = {}) => ({
  HEDERA_NETWORK: "testnet",
  HEDERA_HCS_TOPIC_ID: TOPIC,
  HEDERA_CREDENTIAL_REGISTRY_ADDRESS: REGISTRY,
  ...extra,
});

describe("credential audit configuration", () => {
  it("loads a valid configuration with the default poll timeout", () => {
    expect(loadCredentialAuditConfig(env())).toMatchObject({
      network: { name: "testnet" },
      registryAddress: REGISTRY,
      topicId: TOPIC,
      pollTimeoutMs: 20_000,
    });
    expect(loadCredentialAuditConfig(env({ HEDERA_AUDIT_POLL_TIMEOUT_MS: "0" })).pollTimeoutMs).toBe(0);
  });

  it("reports every invalid variable at once", () => {
    try {
      loadCredentialAuditConfig({
        HEDERA_NETWORK: "devnet",
        HEDERA_HCS_TOPIC_ID: "topic",
        HEDERA_CREDENTIAL_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000000000",
        HEDERA_AUDIT_POLL_TIMEOUT_MS: "-1",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialAuditConfigError);
      expect((error as CredentialAuditConfigError).issues.map(i => i.variable)).toEqual([
        "HEDERA_NETWORK",
        "HEDERA_HCS_TOPIC_ID",
        "HEDERA_CREDENTIAL_REGISTRY_ADDRESS",
        "HEDERA_AUDIT_POLL_TIMEOUT_MS",
      ]);
    }
  });

  it("wires a working audit context from the configuration", async () => {
    const clock = virtualClock(Number((REVOKED_AT + 30n) * 1000n));
    const ctx = createCredentialAuditContext(loadCredentialAuditConfig(env()), {
      fetch: fakeFetch(await consistentWorld()).fetch,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect((await auditCredential(CREDENTIAL_ID, ctx)).evidence).toBe("consistent");
  });
});
