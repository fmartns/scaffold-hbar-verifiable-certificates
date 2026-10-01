import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IssuerFlowError } from "@sh/sdk/hedera/wallet";
import { AuditPanel } from "./AuditPanel";
import { CREDENTIAL_ID, TX_HASH, auditReport } from "./test-utils";

afterEach(cleanup);

describe("AuditPanel", () => {
  it("renders the on-chain status, contract events, timeline and provenance of the shared audit", async () => {
    render(<AuditPanel credentialId={CREDENTIAL_ID} fetchAudit={async () => auditReport()} />);
    expect(await screen.findByText("On-chain: issued")).toBeTruthy();
    expect(screen.getByText("Evidence consistent")).toBeTruthy();
    expect(screen.getByText("CredentialIssued")).toBeTruthy();
    expect(screen.getByText("HCS issuance evidence")).toBeTruthy();
    expect(screen.getAllByText(TX_HASH).length).toBeGreaterThan(0);
    expect(screen.getByText(/HCS is evidence, not validity/)).toBeTruthy();
  });

  it("shows findings with their severity", async () => {
    const report = auditReport({
      evidence: "inconsistent",
      findings: [{ code: "HCS_DIGEST_MISMATCH", severity: "high", message: "The HCS digest differs." }],
    });
    render(<AuditPanel credentialId={CREDENTIAL_ID} fetchAudit={async () => report} />);
    expect(await screen.findByText("Evidence inconsistent")).toBeTruthy();
    expect(screen.getByText("HCS_DIGEST_MISMATCH")).toBeTruthy();
  });

  it("asks again while the Mirror Node has not indexed the facts, then stops", async () => {
    let calls = 0;
    const fetchAudit = async () => {
      calls += 1;
      return calls < 3 ? auditReport({ evidence: "pending_index", timeline: [], issuance: null }) : auditReport();
    };
    render(<AuditPanel credentialId={CREDENTIAL_ID} fetchAudit={fetchAudit} retryDelayMs={1} maxRetries={5} />);
    expect(await screen.findByText("Waiting for Mirror Node indexing")).toBeTruthy();
    expect(screen.getByText("No CredentialRegistry event indexed yet.")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Evidence consistent")).toBeTruthy());
    expect(calls).toBe(3);
  });

  it("renders a legible error when the audit cannot run", async () => {
    const fetchAudit = async () => {
      throw new IssuerFlowError({
        category: "rpc_unavailable",
        code: "MIRROR_UNREACHABLE",
        title: "Mirror Node unreachable",
        message: "The Mirror Node did not answer.",
        remediation: "Retry in a minute.",
      });
    };
    render(<AuditPanel credentialId={CREDENTIAL_ID} fetchAudit={fetchAudit} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Mirror Node unreachable");
    expect(alert.textContent).toContain("Retry in a minute.");
  });
});
