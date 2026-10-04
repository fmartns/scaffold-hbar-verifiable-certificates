import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sh/sdk/certificates", () => {
  class CertificateError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { CertificateError };
});
const publicCertificate = vi.fn();
vi.mock("../../api/_lib/server", () => ({ certificateService: async () => ({ publicCertificate }) }));
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));

const { default: CertificatePage } = await import("./page");
const { CertificateError } = await import("@sh/sdk/certificates");
const page = (id = "c-1") => CertificatePage({ params: Promise.resolve({ id }) });

describe("public certificate page", () => {
  it("shows the public data and the document check, and says it does not decide validity", async () => {
    publicCertificate.mockResolvedValueOnce({
      certificateId: "c-1",
      holderName: "Ana Example",
      course: "Solidity Basics",
      issuedOn: "2026-10-03",
      issuerName: "Hedera Academy",
      issuerDid: "did:hedera:testnet:z_0.0.1",
      credentialDefinitionId: "cd",
      documentTopicId: "0.0.2",
      documentSha256: "ab".repeat(32),
      documentIntegrity: { valid: true },
      links: {
        documentTopic: "https://h/topic/0.0.2",
        documentMessages: "https://m/0.0.2",
        issuerDid: "https://h/0.0.1",
      },
    });
    render(await page());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Solidity Basics");
    expect(screen.getByText("VALID")).toBeTruthy();
    expect(screen.getByText(/This page does not say, on purpose/)).toBeTruthy();
  });

  it("is a 404 for an unknown certificate or an issuer that was never published", async () => {
    for (const code of ["NOT_FOUND", "ISSUER_NOT_INITIALIZED"] as const) {
      publicCertificate.mockRejectedValueOnce(new CertificateError(code, "x"));
      await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
    }
  });

  it("explains a typed failure (no .env, Mirror Node down) instead of failing with a 500", async () => {
    publicCertificate.mockRejectedValueOnce(new CertificateError("INVALID_INPUT", "HEDERA_OPERATOR_ID is not set."));
    render(await page());
    expect(screen.getByRole("alert").textContent).toBe("HEDERA_OPERATOR_ID is not set.");
    expect(screen.getByText(/yarn setup/)).toBeTruthy();
  });

  it("lets unexpected errors reach the error boundary without showing their text", async () => {
    publicCertificate.mockRejectedValueOnce(new Error("secret detail"));
    await expect(page()).rejects.toThrow("secret detail");
  });
});
