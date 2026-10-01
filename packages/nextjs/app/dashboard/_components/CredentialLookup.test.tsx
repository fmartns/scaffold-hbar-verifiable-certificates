import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialStatusLookup } from "~~/hooks/useCredentialRegistry";
import { CredentialLookup } from "./CredentialLookup";

const ID = `0x${"ab".repeat(32)}`;
const ISSUER = `0x${"cd".repeat(32)}`;
const getCredentialStatus = vi.fn();
let state: { deployment: unknown; lookup: CredentialStatusLookup };

vi.mock("~~/hooks/useCredentialRegistry", () => ({
  useCredentialRegistry: () => ({ ...state, getCredentialStatus }),
}));

const ready = (source: "manifest" | "env", hashscanUrl: string | null = null) => ({
  status: "ready",
  contract: { address: `0x${"12".repeat(20)}`, contractId: "0.0.7777", source, hashscanUrl },
});

describe("CredentialLookup", () => {
  beforeEach(() => {
    getCredentialStatus.mockReset();
    state = { deployment: ready("manifest"), lookup: { status: "idle" } };
  });

  it("explains how to deploy when the registry is not deployed on the network", () => {
    state.deployment = { status: "missing", message: "Run yarn deploy --network hederaTestnet." };
    render(<CredentialLookup network="testnet" address={null} />);

    expect(screen.getByText("Run yarn deploy --network hederaTestnet.")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("names the address source, links HashScan and reads statusOf for the typed credentialId", () => {
    state.deployment = ready("env", "https://hashscan.io/testnet/contract/0.0.7777");
    render(<CredentialLookup network="testnet" address={null} />);

    expect(screen.getByText("(configured address)")).toBeTruthy();
    expect(screen.getByRole("link", { name: /HashScan/ }).getAttribute("rel")).toBe("noreferrer");
    const input = screen.getByRole("textbox");
    expect(input.getAttribute("placeholder")).toMatch(/^0x[0-9a-f]{64}$/);
    const button = screen.getByRole("button", { name: "Read statusOf" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(input, { target: { value: ID } });
    fireEvent.click(button);
    expect(getCredentialStatus).toHaveBeenCalledWith(ID);
  });

  it("shows the manifest as the source and a busy button while reading", () => {
    state.lookup = { status: "loading", credentialId: ID };
    render(<CredentialLookup network="testnet" address={null} />);

    expect(screen.getByText("(generated manifest)")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Reading…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders an issued record with its timestamps and issuer", () => {
    state.lookup = {
      status: "done",
      credentialId: ID,
      record: { status: "issued", issuedAt: 1_758_196_800n, revokedAt: 0n, issuer: ISSUER },
    } as CredentialStatusLookup;
    render(<CredentialLookup network="testnet" address={null} />);

    expect(screen.getByText("issued")).toBeTruthy();
    expect(screen.getByText("18/09/2025, 12:00:00 UTC")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText(ISSUER).tagName).toBe("CODE");
  });

  it("renders not_found without record details", () => {
    state.lookup = {
      status: "done",
      credentialId: ID,
      record: { status: "not_found", issuedAt: 0n, revokedAt: 0n, issuer: `0x${"0".repeat(64)}` },
    } as CredentialStatusLookup;
    render(<CredentialLookup network="testnet" address={null} />);

    expect(screen.getByText("not_found")).toBeTruthy();
    expect(screen.queryByText("Issuer")).toBeNull();
  });

  it("shows a legible error", () => {
    state.lookup = {
      status: "error",
      credentialId: "nope",
      message: "A credentialId is 0x followed by 64 hex characters.",
    };
    render(<CredentialLookup network="testnet" address={null} />);

    expect(screen.getByText("A credentialId is 0x followed by 64 hex characters.")).toBeTruthy();
  });
});
