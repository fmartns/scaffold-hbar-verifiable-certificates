import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CREDENTIAL_SCHEMA_PRESETS } from "@sh/sdk/hedera/wallet";
import { IssuerConsole } from "./IssuerConsole";
import {
  ACCOUNT,
  CREDENTIAL_ID,
  SETTINGS,
  TARGET,
  TX_HASH,
  auditReport,
  fail,
  fakeApi,
  installWallet,
  ok,
  receipt,
  revert,
  uninstallWallet,
} from "./test-utils";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const FLOW = { now: () => NOW, sleep: async () => undefined, receiptPollMs: 0 };

function renderConsole(fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof IssuerConsole>[0]> = {}) {
  return render(
    <IssuerConsole
      settings={SETTINGS}
      target={TARGET}
      addChain={null}
      fetchImpl={fetchImpl}
      flowOptions={FLOW}
      {...overrides}
    />,
  );
}

function fillIssueForm() {
  const form = screen.getByRole("heading", { name: "Issue a credential" }).closest("section") as HTMLElement;
  const set = (label: string, value: string) =>
    fireEvent.change(within(form).getByLabelText(label), { target: { value } });
  set("Issuer namespace", "acme-university");
  set("Credential type", CREDENTIAL_SCHEMA_PRESETS[1].descriptor);
  set("Credential reference", "ENR-2026-0042");
  set("Course code", "CS-301");
  set("Course name", "Distributed Ledgers");
  set("Completed on", "2026-09-20");
  set("Hours", "60");
  set("Grade", "A");
  set("Holder identifier type", "email");
  set("Holder identifier", "maria.silva@example.com");
  set("Issue date", "2026-09-21");
  return form;
}

async function issue() {
  const form = fillIssueForm();
  await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());
  fireEvent.click(within(form).getByRole("button", { name: "Issue credential" }));
  return form;
}

const stepState = (scope: HTMLElement, step: string) =>
  scope.querySelector(`[data-step="${step}"]`)?.getAttribute("data-state");

const alertIn = async (scope: HTMLElement) => within(scope).findByRole("alert");

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  uninstallWallet();
});

describe("IssuerConsole: form", () => {
  it("gives every editable field a concrete placeholder and every select a 'Selecione…' first option", () => {
    installWallet();
    const { container } = renderConsole(fakeApi({}).fetchImpl);
    const inputs = container.querySelectorAll("input, textarea");
    expect(inputs.length).toBe(7);
    for (const input of inputs) expect(input.getAttribute("placeholder")?.trim()).toBeTruthy();
    const selects = container.querySelectorAll("select");
    expect(selects.length).toBe(3);
    for (const select of selects) expect(select.querySelector("option")?.textContent).toBe("Selecione…");
  });

  it("disables issuing and revoking and lists the missing variables when the server is not configured", () => {
    installWallet();
    renderConsole(fakeApi({}).fetchImpl, {
      settings: {
        ...SETTINGS,
        configured: false,
        registryAddress: null,
        issues: [{ variable: "CREDENTIAL_REGISTRY_ADDRESS", message: "is required" }],
      },
    });
    expect(screen.getByRole("heading", { name: "Not configured" })).toBeTruthy();
    expect(screen.getByText("CREDENTIAL_REGISTRY_ADDRESS")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Issue credential" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Revoke…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("highlights invalid fields without signing or sending anything", async () => {
    const wallet = installWallet();
    const api = fakeApi({});
    renderConsole(api.fetchImpl);
    await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Issue credential" }));
    const form = screen.getByRole("heading", { name: "Issue a credential" }).closest("section") as HTMLElement;
    expect(within(await alertIn(form)).getByText("Check the form")).toBeTruthy();
    expect(wallet.calls).not.toContain("eth_signTypedData_v4");
    expect(api.requests).toHaveLength(0);
  });
});

describe("IssuerConsole: issuance", () => {
  it("publishes to HCS before registering, then shows the credential ID, QR code and HashScan link", async () => {
    const wallet = installWallet();
    const api = fakeApi({ publish: ok(receipt("issuance")), audit: ok(auditReport()) });
    renderConsole(api.fetchImpl);

    const form = await issue();
    const result = await within(form).findByRole("status", { name: "Issuance result" });
    const credentialId = within(result).getByTestId("credential-id").textContent ?? "";
    expect(credentialId).toMatch(/^0x[0-9a-f]{64}$/);

    const hashscan = within(result).getByRole("link", { name: /View on HashScan/ });
    expect(hashscan.getAttribute("href")).toBe(receipt("issuance").hashscanUrl);
    const qr = await within(result).findByRole("img", { name: `QR code of credential ID ${credentialId}` });
    expect(qr.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(within(result).getByText(TX_HASH)).toBeTruthy();

    // D11: the HCS publication (fetch) happens before the registry transaction (wallet).
    const sendIndex = wallet.calls.indexOf("eth_sendTransaction");
    expect(api.requests[0].path).toBe("publish");
    expect(sendIndex).toBeGreaterThan(wallet.calls.indexOf("eth_call"));
    expect(stepState(form, "publish")).toBe("done");
    expect(stepState(form, "confirm")).toBe("done");

    // Raw PII never leaves the browser nor stays in it.
    const sent = JSON.stringify(api.requests);
    expect(sent).not.toContain("maria.silva");
    const published = api.requests[0].body as { kind: string; event: Record<string, string> };
    expect(published.kind).toBe("issuance");
    expect(published.event.subjectCommitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(published.event.credentialHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(localStorage.getItem("sh.issuer.activity.v1")).toContain(credentialId);
    expect(localStorage.getItem("sh.issuer.activity.v1")).not.toContain("maria.silva");
    expect((within(form).getByLabelText("Holder identifier") as HTMLInputElement).value).toBe("");

    // The shared audit runs on the new credential.
    expect(await screen.findByText("Evidence consistent")).toBeTruthy();
    expect(screen.getByText("CredentialIssued")).toBeTruthy();
  });

  it("downloads the holder document locally, never through the server", async () => {
    installWallet();
    const api = fakeApi({ publish: ok(receipt("issuance")), audit: ok(auditReport()) });
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => (blobs.push(blob), "blob:holder-document"));
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderConsole(api.fetchImpl);

    const form = await issue();
    const result = await within(form).findByRole("status", { name: "Issuance result" });
    const requestsBefore = api.requests.length;
    fireEvent.click(within(result).getByRole("button", { name: "Download credential document (JSON)" }));

    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:holder-document");
    const text = await new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blobs[0]);
    });
    const document = JSON.parse(text) as Record<string, unknown>;
    expect(JSON.stringify(document)).toContain("maria.silva@example.com");
    expect(api.requests).toHaveLength(requestsBefore);
    click.mockRestore();
  });

  it("explains a missing wallet", async () => {
    renderConsole(fakeApi({}).fetchImpl);
    expect(await screen.findByText("No wallet")).toBeTruthy();
    const form = fillIssueForm();
    fireEvent.click(within(form).getByRole("button", { name: "Issue credential" }));
    expect(within(await alertIn(form)).getByText("Wallet not connected")).toBeTruthy();
  });

  it("explains a disconnected wallet (no account)", async () => {
    installWallet({ accounts: [] });
    renderConsole(fakeApi({}).fetchImpl);
    expect(await screen.findByRole("button", { name: "Connect wallet" })).toBeTruthy();
    const form = fillIssueForm();
    fireEvent.click(within(form).getByRole("button", { name: "Issue credential" }));
    expect(within(await alertIn(form)).getByText("Wallet not connected")).toBeTruthy();
  });

  it("explains the wrong network and offers to switch", async () => {
    installWallet({ chainId: "0x1" });
    renderConsole(fakeApi({}).fetchImpl);
    expect(await screen.findByText(/Wrong network \(chain 1\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch to testnet" })).toBeTruthy();
    const form = await issue();
    expect(within(await alertIn(form)).getByText("Wrong network")).toBeTruthy();
  });

  it("explains a signature rejected in the wallet, with nothing published", async () => {
    installWallet({
      overrides: { eth_signTypedData_v4: Object.assign(new Error("User rejected"), { code: 4001 }) },
    });
    const api = fakeApi({});
    renderConsole(api.fetchImpl);
    const form = await issue();
    const alert = await alertIn(form);
    expect(within(alert).getByText("Rejected in the wallet")).toBeTruthy();
    expect(alert.getAttribute("data-category")).toBe("rejected");
    expect(api.requests).toHaveLength(0);
    expect(stepState(form, "sign")).toBe("failed");
    expect(stepState(form, "publish")).toBe("pending");
  });

  it("explains an unregistered issuer caught by the dry-run, with nothing published", async () => {
    installWallet({ overrides: { eth_call: revert("UnknownIssuer", [`0x${"77".repeat(32)}`]) } });
    const api = fakeApi({});
    renderConsole(api.fetchImpl);
    const form = await issue();
    const alert = await alertIn(form);
    expect(within(alert).getByText("Issuer not registered")).toBeTruthy();
    expect(alert.getAttribute("data-category")).toBe("issuer_not_registered");
    expect(api.requests).toHaveLength(0);
  });

  it("shows the server's issuer check (403)", async () => {
    installWallet();
    const api = fakeApi({
      publish: fail(403, {
        category: "issuer_not_registered",
        code: "UnauthorizedSigner",
        title: "Wallet is not the issuer's signer",
        message: `The connected account ${ACCOUNT} is not the registered signer.`,
        remediation: "Select the registered signer.",
      }),
    });
    renderConsole(api.fetchImpl);
    const form = await issue();
    expect(within(await alertIn(form)).getByText("Wallet is not the issuer's signer")).toBeTruthy();
  });

  it("shows a Hedera error from the HCS publication with its status and transaction ID", async () => {
    const wallet = installWallet();
    const api = fakeApi({
      publish: fail(502, {
        category: "hedera",
        code: "INSUFFICIENT_PAYER_BALANCE",
        title: "Hedera rejected the HCS publication",
        message: "The operator account cannot pay for the message.",
        remediation: "Fund the operator account and retry.",
        hederaStatus: "INSUFFICIENT_PAYER_BALANCE",
        transactionId: "0.0.1001@1790000000.000000001",
      }),
    });
    renderConsole(api.fetchImpl);
    const form = await issue();
    const alert = await alertIn(form);
    expect(within(alert).getByText("Hedera rejected the HCS publication")).toBeTruthy();
    expect(within(alert).getByText("0.0.1001@1790000000.000000001")).toBeTruthy();
    expect(wallet.calls).not.toContain("eth_sendTransaction");
  });

  it("explains an unreachable console server", async () => {
    installWallet();
    renderConsole(fakeApi({ publish: new TypeError("Failed to fetch") }).fetchImpl);
    const form = await issue();
    const alert = await alertIn(form);
    expect(within(alert).getByText("Network unreachable")).toBeTruthy();
    expect(alert.getAttribute("data-category")).toBe("rpc_unavailable");
  });

  it("times out waiting for the registry receipt and keeps the HCS evidence and tx hash", async () => {
    installWallet({ receipt: null });
    let clock = NOW;
    renderConsole(fakeApi({ publish: ok(receipt("issuance")) }).fetchImpl, {
      flowOptions: {
        now: () => clock,
        sleep: async () => {
          clock += 1_000;
        },
        receiptTimeoutMs: 3_000,
        receiptPollMs: 0,
      },
    });
    const form = await issue();
    const alert = await alertIn(form);
    expect(alert.getAttribute("data-category")).toBe("timeout");
    expect(within(alert).getByText(TX_HASH)).toBeTruthy();
    expect(
      within(alert)
        .getByRole("link", { name: /HashScan/ })
        .getAttribute("href"),
    ).toBe(receipt("issuance").hashscanUrl);
  });

  it("recovers the contract's reason when the registry transaction reverts", async () => {
    let calls = 0;
    installWallet({
      receipt: { status: "0x0", blockNumber: "0x10" },
      overrides: {
        eth_call: () => {
          calls += 1;
          if (calls === 1) return "0x";
          throw revert("AlreadyIssued", [CREDENTIAL_ID, 1790000005n]);
        },
      },
    });
    renderConsole(fakeApi({ publish: ok(receipt("issuance")) }).fetchImpl);
    const form = await issue();
    const alert = await alertIn(form);
    expect(within(alert).getByText("Credential already issued")).toBeTruthy();
    expect(within(alert).getByText(TX_HASH)).toBeTruthy();
  });
});

describe("IssuerConsole: revocation", () => {
  const revokeSection = () =>
    screen.getByRole("heading", { name: "Revoke a credential" }).closest("section") as HTMLElement;

  function fillRevoke(credentialId = CREDENTIAL_ID) {
    const section = revokeSection();
    fireEvent.change(within(section).getByLabelText("Credential ID"), { target: { value: credentialId } });
    fireEvent.change(within(section).getByLabelText("Reason"), { target: { value: "issued_in_error" } });
    fireEvent.click(within(section).getByRole("button", { name: "Revoke…" }));
    return section;
  }

  const issued = {
    credentialId: CREDENTIAL_ID,
    status: "issued",
    issuer: `0x${"77".repeat(32)}`,
    signer: ACCOUNT,
    issuedAt: "1790000005",
    revokedAt: "0",
  };
  const issuedStatus = ok(issued);

  it("validates the form before asking for confirmation", async () => {
    installWallet();
    renderConsole(fakeApi({}).fetchImpl);
    const section = fillRevoke("0x1234");
    expect(within(section).getByText(/0x followed by 64 hex characters/)).toBeTruthy();
    expect(within(section).queryByRole("alertdialog")).toBeNull();
  });

  it("asks for confirmation, and Cancel sends nothing", async () => {
    const wallet = installWallet();
    const api = fakeApi({});
    renderConsole(api.fetchImpl);
    await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());
    const section = fillRevoke();
    const dialog = within(section).getByRole("alertdialog");
    expect(within(dialog).getByText("Revoke this credential?")).toBeTruthy();
    expect(dialog.textContent).toContain(CREDENTIAL_ID);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(within(section).queryByRole("alertdialog")).toBeNull();
    expect(api.requests).toHaveLength(0);
    expect(wallet.calls).not.toContain("eth_signTypedData_v4");
  });

  it("revokes after confirmation: HCS evidence first, then the registry, then the audit", async () => {
    const wallet = installWallet();
    const api = fakeApi({
      status: issuedStatus,
      publish: ok(receipt("revocation")),
      audit: ok(auditReport({ onChain: { status: "revoked", record: null } })),
    });
    renderConsole(api.fetchImpl);
    await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());
    const section = fillRevoke();
    fireEvent.click(within(section).getByRole("button", { name: "Confirm revocation" }));
    const result = await within(section).findByRole("status", { name: "Revocation result" });
    expect(within(result).getByText("Credential revoked")).toBeTruthy();
    expect(
      within(result)
        .getByRole("link", { name: /View on HashScan/ })
        .getAttribute("href"),
    ).toBe(receipt("revocation").hashscanUrl);
    expect(api.requests.map(r => r.path)).toEqual(["status", "publish", "audit"]);
    expect((api.requests[1].body as { kind: string }).kind).toBe("revocation");
    expect(wallet.calls).toContain("eth_sendTransaction");
    expect(await screen.findByText("On-chain: revoked")).toBeTruthy();
  });

  it("refuses to revoke a credential that is already revoked, before signing", async () => {
    const wallet = installWallet();
    renderConsole(fakeApi({ status: ok({ ...issued, status: "revoked", revokedAt: "1" }) }).fetchImpl);
    await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());
    const section = fillRevoke();
    fireEvent.click(within(section).getByRole("button", { name: "Confirm revocation" }));
    expect(within(await alertIn(section)).getByText("Already revoked")).toBeTruthy();
    expect(wallet.calls).not.toContain("eth_signTypedData_v4");
  });

  it("explains a rejected revoke transaction", async () => {
    installWallet({
      overrides: { eth_sendTransaction: Object.assign(new Error("denied"), { code: "ACTION_REJECTED" }) },
    });
    renderConsole(fakeApi({ status: issuedStatus, publish: ok(receipt("revocation")) }).fetchImpl);
    await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());
    const section = fillRevoke();
    fireEvent.click(within(section).getByRole("button", { name: "Confirm revocation" }));
    expect(within(await alertIn(section)).getByText("Rejected in the wallet")).toBeTruthy();
  });
});
