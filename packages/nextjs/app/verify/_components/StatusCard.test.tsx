import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialStatusView, IssuerError } from "@sh/sdk/hedera/wallet";
import { StatusCard } from "./StatusCard";

afterEach(cleanup);

const ISSUER = `0x${"aa".repeat(32)}`;
const CREDENTIAL_ID = `0x${"11".repeat(32)}`;

const issued: CredentialStatusView = {
  credentialId: CREDENTIAL_ID as `0x${string}`,
  status: "issued",
  issuer: ISSUER as `0x${string}`,
  signer: `0x${"bb".repeat(20)}` as `0x${string}`,
  issuedAt: "1790000000",
  revokedAt: "0",
};

describe("StatusCard", () => {
  it("shows a loading message before anything resolves", () => {
    render(<StatusCard credentialId={CREDENTIAL_ID} view={null} error={null} loading />);
    expect(screen.getByText("Checking CredentialRegistry…")).toBeTruthy();
  });

  it("answers the existence, issuer, date and status questions for an active credential", () => {
    render(<StatusCard credentialId={CREDENTIAL_ID} view={issued} error={null} loading={false} />);
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Does this credential exist?")).toBeTruthy();
    expect(screen.getByText(/Yes — it is recorded/)).toBeTruthy();
    expect(screen.getByText(ISSUER)).toBeTruthy();
    expect(screen.getByText("Valid — it has not been revoked.")).toBeTruthy();
    expect(screen.getByText(/2026-09-21/)).toBeTruthy();
  });

  it("shows the revocation date for a revoked credential", () => {
    const revoked: CredentialStatusView = { ...issued, status: "revoked", revokedAt: "1790100000" };
    render(<StatusCard credentialId={CREDENTIAL_ID} view={revoked} error={null} loading={false} />);
    expect(screen.getByText("Revoked")).toBeTruthy();
    expect(screen.getByText(/Revoked on/)).toBeTruthy();
    expect(screen.getByText(/no longer valid/)).toBeTruthy();
  });

  it("shows a specific not-found message, never a generic error", () => {
    const notFound: CredentialStatusView = { ...issued, status: "not_found", issuer: issued.issuer };
    render(<StatusCard credentialId={CREDENTIAL_ID} view={notFound} error={null} loading={false} />);
    expect(screen.getByText("Not found")).toBeTruthy();
    expect(screen.getByText(/No record of this credential id exists/)).toBeTruthy();
  });

  it("renders the classified error (e.g. registry/network unavailable) distinctly from not-found", () => {
    const error: IssuerError = {
      category: "rpc_unavailable",
      code: "REGISTRY_UNAVAILABLE",
      title: "JSON-RPC relay unreachable",
      message: "Could not read the registry.",
      remediation: "Retry in a few seconds.",
    };
    render(<StatusCard credentialId={CREDENTIAL_ID} view={null} error={error} loading={false} />);
    expect(screen.getByText("JSON-RPC relay unreachable")).toBeTruthy();
    expect(screen.queryByText("Not found")).toBeNull();
  });
});
