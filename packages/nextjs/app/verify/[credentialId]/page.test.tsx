import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditReport, fakeApi, ok } from "../../issuer/_components/test-utils";
import VerifyCredentialPage from "./page";

const CREDENTIAL_ID = `0x${"11".repeat(32)}`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage(credentialId: string) {
  return render(await VerifyCredentialPage({ params: Promise.resolve({ credentialId }) }));
}

describe("/verify/[credentialId]", () => {
  it("renders the public verification page and queries the status and audit APIs for a valid id", async () => {
    const { fetchImpl, requests } = fakeApi({
      status: ok({
        credentialId: CREDENTIAL_ID,
        status: "issued",
        issuer: `0x${"aa".repeat(32)}`,
        signer: `0x${"bb".repeat(20)}`,
        issuedAt: "1790000000",
        revokedAt: "0",
      }),
      audit: ok(auditReport({ credentialId: CREDENTIAL_ID as `0x${string}` })),
    });
    vi.stubGlobal("fetch", fetchImpl);
    await renderPage(CREDENTIAL_ID);
    expect(screen.getByRole("heading", { name: "Credential verification" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Active")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("On-chain: issued")).toBeTruthy());
    expect(requests.map(r => r.path)).toEqual(expect.arrayContaining(["status", "audit"]));
  });

  it("shows a specific invalid-id message, never a generic error, for a malformed id and never calls the API", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await renderPage("not-a-credential-id");
    expect(await screen.findByText("Invalid credential id")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
