/**
 * OPTIONAL integration test against the real Hedera Testnet Mirror Node. Read-only (costs nothing) and skipped unless
 * explicitly enabled, because real indexing latency makes it timing-dependent:
 *
 *     AUDIT_INTEGRATION=1 AUDIT_CREDENTIAL_ID=0x... yarn workspace @sh/sdk test:integration
 *
 * Configuration comes from the environment (or the repository's root `.env`): HEDERA_HCS_TOPIC_ID and
 * HEDERA_CREDENTIAL_REGISTRY_ADDRESS of a deployed CredentialRegistry, and a credential issued through it.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { auditCredential } from "./audit";
import { createCredentialAuditContext, loadCredentialAuditConfig } from "./config";

const enabled = process.env.AUDIT_INTEGRATION === "1";

function integrationEnv(): Record<string, string | undefined> {
  const rootEnv = resolve(__dirname, "../../../../.env");
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv); // never overrides variables that are already set
  return { ...process.env, HEDERA_NETWORK: "testnet" };
}

describe.skipIf(!enabled)("credential audit on Hedera Testnet (integration)", () => {
  it("audits a real credential end to end", async () => {
    const env = integrationEnv();
    const credentialId = env.AUDIT_CREDENTIAL_ID;
    if (!credentialId) throw new Error("Set AUDIT_CREDENTIAL_ID to a credential issued on the configured registry.");
    const ctx = createCredentialAuditContext(loadCredentialAuditConfig(env));
    const report = await auditCredential(credentialId, ctx);

    expect(report.onChain.status).not.toBe("unknown");
    expect(report.onChain.status).not.toBe("not_found");
    expect(report.evidence, JSON.stringify(report.findings)).toBe("consistent");
    expect(report.issuance?.hcs?.hashscanUrl).toMatch(/^https:\/\/hashscan\.io\/testnet\/transaction\//);
  }, 120_000);
});
