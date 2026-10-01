import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveCredential } from "@sh/sdk/hedera/wallet";
import type { CredentialDocument } from "@sh/sdk/hedera/wallet";
import { auditReport } from "../../issuer/_components/test-utils";
import { HashCheck } from "./HashCheck";

afterEach(cleanup);

const DOCUMENT: CredentialDocument = {
  version: 1,
  issuer: "acme-university",
  schema: "course-completion.v1(string courseCode,string courseName,uint64 completedOn,uint64 hours,string grade)",
  reference: "ENR-2026-0042",
  subject: { idType: "email", idValue: "maria.silva@example.com", salt: `0x${"77".repeat(32)}` },
  issuedAt: 1_790_000_000,
  expiresAt: 0,
  claims: {
    courseCode: "CS-301",
    courseName: "Distributed Ledgers",
    completedOn: 1_790_000_000,
    hours: 60,
    grade: "A",
  },
};

const model = () => {
  const result = deriveCredential(DOCUMENT);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
};

function fillAndSubmit(document: unknown) {
  fireEvent.change(screen.getByLabelText("Credential JSON"), { target: { value: JSON.stringify(document) } });
  fireEvent.click(screen.getByRole("button", { name: "Check integrity" }));
}

describe("HashCheck", () => {
  it("reports content matches when the recomputed hash and subject commitment equal the on-chain record", async () => {
    const m = model();
    const fetchAudit = vi.fn().mockResolvedValue(
      auditReport({
        credentialId: m.credentialId,
        onChain: {
          status: "issued",
          record: {
            status: "issued",
            issuer: m.issuer,
            credentialHash: m.credentialHash,
            subjectCommitment: m.subjectCommitment,
            signer: `0x${"bb".repeat(20)}`,
            issuedAt: "1790000005",
            revokedAt: "0",
          },
        },
      }),
    );
    render(<HashCheck credentialId={m.credentialId} fetchAudit={fetchAudit} />);
    fillAndSubmit(DOCUMENT);
    expect(await screen.findByText("Content matches")).toBeTruthy();
    expect(fetchAudit).toHaveBeenCalledWith(m.credentialId);
  });

  it("reports content diverges when the recomputed hash differs from the on-chain record", async () => {
    const m = model();
    const fetchAudit = vi.fn().mockResolvedValue(
      auditReport({
        credentialId: m.credentialId,
        onChain: {
          status: "issued",
          record: {
            status: "issued",
            issuer: m.issuer,
            credentialHash: `0x${"ff".repeat(32)}`,
            subjectCommitment: m.subjectCommitment,
            signer: `0x${"bb".repeat(20)}`,
            issuedAt: "1790000005",
            revokedAt: "0",
          },
        },
      }),
    );
    render(<HashCheck credentialId={m.credentialId} fetchAudit={fetchAudit} />);
    fillAndSubmit(DOCUMENT);
    expect(await screen.findByText("Content diverges")).toBeTruthy();
    expect(screen.getByText(/claims in this document differ/)).toBeTruthy();
  });

  it("reports a subject mismatch distinctly from a content hash mismatch", async () => {
    const m = model();
    const fetchAudit = vi.fn().mockResolvedValue(
      auditReport({
        credentialId: m.credentialId,
        onChain: {
          status: "issued",
          record: {
            status: "issued",
            issuer: m.issuer,
            credentialHash: m.credentialHash,
            subjectCommitment: `0x${"ee".repeat(32)}`,
            signer: `0x${"bb".repeat(20)}`,
            issuedAt: "1790000005",
            revokedAt: "0",
          },
        },
      }),
    );
    render(<HashCheck credentialId={m.credentialId} fetchAudit={fetchAudit} />);
    fillAndSubmit(DOCUMENT);
    expect(await screen.findByText("Content diverges")).toBeTruthy();
    expect(screen.getByText(/holder identifier \(subject commitment\)/)).toBeTruthy();
  });

  it("says a document belongs to another credential when its derived id does not match the one being verified", async () => {
    render(<HashCheck credentialId={`0x${"99".repeat(32)}`} fetchAudit={vi.fn()} />);
    fillAndSubmit(DOCUMENT);
    expect(await screen.findByText("Content diverges")).toBeTruthy();
    expect(screen.getByText(/different credential/)).toBeTruthy();
  });

  it("says there is nothing to compare against when the credential has no on-chain record", async () => {
    const m = model();
    const fetchAudit = vi.fn().mockResolvedValue(auditReport({ onChain: { status: "not_found", record: null } }));
    render(<HashCheck credentialId={m.credentialId} fetchAudit={fetchAudit} />);
    fillAndSubmit(DOCUMENT);
    expect(await screen.findByText("Cannot compare")).toBeTruthy();
  });

  it("rejects text that is not valid JSON", async () => {
    render(<HashCheck credentialId={`0x${"11".repeat(32)}`} fetchAudit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Credential JSON"), { target: { value: "{not json" } });
    fireEvent.click(screen.getByRole("button", { name: "Check integrity" }));
    expect(await screen.findByText("Invalid input")).toBeTruthy();
  });

  it("reports the document's own validation issues when it is not a recognizable credential", async () => {
    render(<HashCheck credentialId={`0x${"11".repeat(32)}`} fetchAudit={vi.fn()} />);
    fillAndSubmit({ version: 1 });
    expect(await screen.findByText("Not a recognizable credential document")).toBeTruthy();
  });

  it("shows the classified error when the on-chain record cannot be fetched", async () => {
    const m = model();
    const fetchAudit = vi.fn().mockRejectedValue(new Error("network down"));
    render(<HashCheck credentialId={m.credentialId} fetchAudit={fetchAudit} />);
    fillAndSubmit(DOCUMENT);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  });

  it("loads the document from an uploaded file into the textarea", async () => {
    render(<HashCheck credentialId={`0x${"11".repeat(32)}`} fetchAudit={vi.fn()} />);
    const file = new File([JSON.stringify(DOCUMENT)], "credential.json", { type: "application/json" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect((screen.getByLabelText("Credential JSON") as HTMLTextAreaElement).value).toContain("acme-university"),
    );
  });

  it("keeps the check button disabled until there is something to check", () => {
    render(<HashCheck credentialId={`0x${"11".repeat(32)}`} fetchAudit={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Check integrity" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
