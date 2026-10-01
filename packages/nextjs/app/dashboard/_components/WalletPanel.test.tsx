import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addEthereumChainParameter, walletTarget } from "@sh/sdk/hedera/wallet";
import { WalletPanel } from "./WalletPanel";

const TARGET = walletTarget("testnet");
const ADD_CHAIN = addEthereumChainParameter("testnet");
const ADDRESS = `0x${"ab".repeat(20)}`;
const ONE_HBAR_WEIBARS = `0x${(10n ** 18n).toString(16)}`;

type Handler = (params?: unknown[]) => unknown;

/** A scripted EIP-1193 provider. Unscripted methods reject like a wallet would. */
function fakeWallet(script: Record<string, Handler>) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const calls: string[] = [];
  const provider = {
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      calls.push(method);
      const handler = script[method];
      if (!handler) throw Object.assign(new Error("unsupported"), { code: 4200 });
      return handler(params);
    }),
    on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
    removeListener: (event: string) => listeners.delete(event),
  };
  window.ethereum = provider;
  return { provider, calls, emit: (event: string, value: unknown) => act(() => listeners.get(event)?.(value)) };
}

const rejectWith = (code: number) => () => {
  throw Object.assign(new Error("wallet error"), { code });
};

function stubAccountLookup(body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const renderPanel = () => render(<WalletPanel target={TARGET} addChain={ADD_CHAIN} />);

afterEach(() => {
  delete window.ethereum;
});

describe("WalletPanel", () => {
  it("works without a wallet and says how to get one", async () => {
    renderPanel();
    expect(await screen.findByText(/No EVM wallet detected/)).toBeTruthy();
    expect(screen.getByText("Disconnected")).toBeTruthy();
  });

  it("offers to connect an available wallet without prompting on load", async () => {
    const wallet = fakeWallet({ eth_accounts: () => [], eth_chainId: () => TARGET.chainIdHex });
    renderPanel();

    expect(await screen.findByRole("button", { name: "Connect wallet" })).toBeTruthy();
    expect(wallet.calls).not.toContain("eth_requestAccounts");
  });

  it("connects on request and shows the balance, Hedera account and HashScan link on the target chain", async () => {
    fakeWallet({
      eth_accounts: () => [],
      eth_chainId: () => TARGET.chainIdHex,
      eth_requestAccounts: () => [ADDRESS.toUpperCase().replace("0X", "0x")],
      eth_getBalance: () => ONE_HBAR_WEIBARS,
    });
    const fetchMock = stubAccountLookup({ status: "found", accountId: "0.0.4321", hashscanUrl: null });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));

    expect(await screen.findByText("0.0.4321")).toBeTruthy();
    expect(screen.getByText(ADDRESS)).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(await screen.findByText("1 HBAR")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(`/api/wallet/account?address=${ADDRESS}`);
    expect(screen.getByRole("link", { name: /Account/ }).getAttribute("href")).toContain("hashscan.io/testnet");
  });

  it.each([
    [{ status: "not_found" }, /gets one when it first receives HBAR/],
    [{ status: "unavailable" }, /could not be resolved right now/],
  ])("explains a Hedera account lookup of %o", async (body, text) => {
    fakeWallet({
      eth_accounts: () => [ADDRESS],
      eth_chainId: () => TARGET.chainIdHex,
      eth_getBalance: () => ONE_HBAR_WEIBARS,
    });
    stubAccountLookup(body);
    renderPanel();
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it("treats a failed account lookup as unavailable", async () => {
    fakeWallet({ eth_accounts: () => [ADDRESS], eth_chainId: () => TARGET.chainIdHex, eth_getBalance: () => "0x0" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    renderPanel();
    expect(await screen.findByText(/could not be resolved right now/)).toBeTruthy();
  });

  it.each([
    [4001, "The request was rejected in the wallet."],
    [-32002, "A request is already pending: open the wallet to answer it."],
    [-32603, "The wallet did not complete the request."],
  ])("explains a connection error %i", async (code, message) => {
    fakeWallet({ eth_accounts: () => [], eth_chainId: () => TARGET.chainIdHex, eth_requestAccounts: rejectWith(code) });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));

    expect(await screen.findByText(message)).toBeTruthy();
  });

  it("offers to switch from another chain and hides chain-specific data meanwhile", async () => {
    const wallet = fakeWallet({
      eth_accounts: () => [ADDRESS],
      eth_chainId: () => "0x1",
      wallet_switchEthereumChain: () => null,
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Switch to testnet" }));

    expect(screen.getByText("Wrong network (chain 1)")).toBeTruthy();
    await waitFor(() => expect(wallet.calls).toContain("wallet_switchEthereumChain"));
    expect(wallet.provider.request).toHaveBeenCalledWith({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: TARGET.chainIdHex }],
    });
    expect(wallet.calls).not.toContain("eth_getBalance");
  });

  it("adds the chain when the wallet does not know it (4902)", async () => {
    const wallet = fakeWallet({
      eth_accounts: () => [ADDRESS],
      eth_chainId: () => "0x1",
      wallet_switchEthereumChain: rejectWith(4902),
      wallet_addEthereumChain: () => null,
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Switch to testnet" }));

    await waitFor(() =>
      expect(wallet.provider.request).toHaveBeenCalledWith({ method: "wallet_addEthereumChain", params: [ADD_CHAIN] }),
    );
  });

  it("says so when the server has no valid target network", async () => {
    fakeWallet({ eth_accounts: () => [ADDRESS], eth_chainId: () => TARGET.chainIdHex });
    render(<WalletPanel target={null} addChain={null} />);
    expect(await screen.findByText("No valid target network is configured.")).toBeTruthy();
  });

  it("follows account and chain changes from the wallet", async () => {
    const wallet = fakeWallet({ eth_accounts: () => [ADDRESS], eth_chainId: () => "0x1" });
    renderPanel();
    expect(await screen.findByRole("button", { name: "Switch to testnet" })).toBeTruthy();

    wallet.emit("accountsChanged", []);

    expect(await screen.findByRole("button", { name: "Connect wallet" })).toBeTruthy();
  });
});
