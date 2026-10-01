import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VerifierBackend } from "../_lib/api";
import { VerifyResult } from "./VerifyResult";
import { auditReport } from "../../issuer/_components/test-utils";

afterEach(cleanup);

const CREDENTIAL_ID = `0x${"11".repeat(32)}`;

function backend(overrides: Partial<VerifierBackend> = {}): VerifierBackend {
  return {
    status: vi.fn().mockResolvedValue({
      credentialId: CREDENTIAL_ID,
      status: "issued",
      issuer: `0x${"aa".repeat(32)}`,
      signer: `0x${"bb".repeat(20)}`,
      issuedAt: "1790000000",
      revokedAt: "0",
    }),
    audit: vi.fn().mockResolvedValue(auditReport()),
    ...overrides,
  };
}

describe("VerifyResult", () => {
  it("fetches and shows the status, evidence and sharing QR code for a valid credential id", async () => {
    const b = backend();
    render(<VerifyResult credentialId={CREDENTIAL_ID} isValidId backend={b} />);
    expect(await screen.findByText("Active")).toBeTruthy();
    expect(b.status).toHaveBeenCalledWith(CREDENTIAL_ID);
    expect(screen.getByText("Share this check")).toBeTruthy();
    expect(await screen.findByText("On-chain: issued")).toBeTruthy();
    expect(screen.getByText("Was the document altered?")).toBeTruthy();
  });

  it("shows a specific invalid-id message and never queries the backend for an invalid credential id", async () => {
    const b = backend();
    render(<VerifyResult credentialId="not-an-id" isValidId={false} backend={b} />);
    expect(await screen.findByText("Invalid credential id")).toBeTruthy();
    expect(b.status).not.toHaveBeenCalled();
    expect(screen.queryByText("Share this check")).toBeNull();
  });

  it("shows the classified error and a retry action when the registry cannot be read", async () => {
    const status = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        credentialId: CREDENTIAL_ID,
        status: "issued",
        issuer: `0x${"aa".repeat(32)}`,
        signer: `0x${"bb".repeat(20)}`,
        issuedAt: "1790000000",
        revokedAt: "0",
      });
    const b = backend({ status });
    render(<VerifyResult credentialId={CREDENTIAL_ID} isValidId backend={b} />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    retry.click();
    await waitFor(() => expect(screen.getByText("Active")).toBeTruthy());
    expect(status).toHaveBeenCalledTimes(2);
  });
});
