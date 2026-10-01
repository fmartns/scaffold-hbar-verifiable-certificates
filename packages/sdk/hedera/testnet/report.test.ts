import { describe, expect, it } from "vitest";
import { ISSUER_SIGNER, fakeTestnet, inspectMatchingKey, testnetEnv } from "../../testing";
import type { FakeTestnetOptions } from "../../testing";
import { computeIssuerId } from "../credentials/schema";
import { EVIDENCE_DIR, buildVerificationReport, renderReportMarkdown, reportJson, reportPaths } from "./report";
import { VERIFY_TESTNET_DEFAULTS, planVerification, runVerification } from "./verification";

const ISSUER_ID = computeIssuerId(VERIFY_TESTNET_DEFAULTS.issuerName);

async function report(
  options: FakeTestnetOptions = {},
  runs = 1,
  before?: (net: ReturnType<typeof fakeTestnet>) => void,
) {
  const net = fakeTestnet({ issuers: { [ISSUER_ID]: { signer: ISSUER_SIGNER.address } }, ...options });
  const deps = {
    fetch: net.fetch,
    inspectKey: inspectMatchingKey,
    now: net.clock.now,
    sleep: net.clock.sleep,
    transport: net.topic.transport,
    manifest: {},
    resolveIssuerKey: async () => ISSUER_SIGNER.privateKey,
    receiptPollMs: 10,
  };
  const plan = await planVerification(testnetEnv, { ...deps, runs });
  if (!plan.ok) throw new Error(plan.problem.code);
  before?.(net);
  return buildVerificationReport(plan.plan, await runVerification(plan.plan, plan.session, deps));
}

describe("verification report", () => {
  it("records every identifier, link, timing and audit verdict of a passing run", async () => {
    const r = await report();
    expect(r).toMatchObject({
      schemaVersion: 1,
      kind: "testnet-credential-validation",
      runId: "20261001T120000Z",
      ok: true,
    });
    expect(reportPaths(r)).toEqual({
      markdown: `${EVIDENCE_DIR}/20261001T120000Z.md`,
      json: `${EVIDENCE_DIR}/20261001T120000Z.json`,
    });

    const md = renderReportMarkdown(r);
    const run = r.result.runs[0];
    expect(md).toContain("# Testnet validation 20261001T120000Z — ✅ passed");
    expect(md).toContain(run.credentialId!);
    expect(md).toContain(run.issuance!.hcs.transactionId);
    expect(md).toContain(run.issuance!.hcs.hashscanUrl!);
    expect(md).toContain(run.revocation!.registry.transactionHash);
    expect(md).toContain("`AlreadyIssued`");
    expect(md).toContain("`ConflictingCredential`");
    expect(md).toContain("`AlreadyRevoked`");
    expect(md).toContain("`chain.revoked`");
    expect(md).toContain("[20261001T120000Z.json](20261001T120000Z.json)");

    const json = reportJson(r);
    expect(JSON.parse(json).result.runs[0].auditAfterRevocation.report.onChain.status).toBe("revoked");
    for (const text of [md, json]) {
      expect(text).not.toContain(testnetEnv.HEDERA_OPERATOR_KEY);
      expect(text).not.toContain(ISSUER_SIGNER.privateKey.slice(2));
      expect(text).not.toContain("@example.com");
    }
  });

  it("shows where a failed run stopped and the steps it never reached", async () => {
    const r = await report({}, 1, net =>
      net.topic.failNext(
        Object.assign(new Error("INSUFFICIENT_PAYER_BALANCE"), { status: "INSUFFICIENT_PAYER_BALANCE" }),
      ),
    );
    const md = renderReportMarkdown(r);
    expect(r.ok).toBe(false);
    expect(md).toContain("❌ failed");
    expect(md).toContain("**Failed at issuance:**");
    expect(md).toContain("| Issuance | not reached | not reached | — |");
    expect(md).toContain("| After issuance | not reached |");
    expect(md).toContain("HCS transaction:");
  });

  it("records the registration of the namespace, or why it failed", async () => {
    const registered = await report({ issuers: {}, admin: ISSUER_SIGNER.address });
    expect(renderReportMarkdown(registered)).toContain("Issuer namespace registered in this run:");

    const refused = await report({ issuers: {}, admin: ISSUER_SIGNER.address }, 1, net =>
      net.issuers.set(ISSUER_ID, { signer: "0x" + "33".repeat(20), active: true, maxValidity: 900n }),
    );
    expect(renderReportMarkdown(refused)).toContain("**Issuer registration failed:** [IssuerAlreadyRegistered]");
  });

  it("says the cost is unknown when it could not be estimated", async () => {
    const r = await report({ usdPerHbar: null });
    expect(renderReportMarkdown(r)).toContain("- Estimated cost: unknown");
  });
});
