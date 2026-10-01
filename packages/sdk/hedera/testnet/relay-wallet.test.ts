import { Interface, Transaction, verifyTypedData } from "ethers";
import { describe, expect, it } from "vitest";
import { DOMAIN, ISSUER_SIGNER, REGISTRY, makeCredentialEvent } from "../../testing";
import { CredentialRegistryAbi } from "../../generated";
import { classifyIssuerError } from "../credentials/errors";
import { credentialEventTypedData } from "../credentials/signing";
import { CREDENTIAL_EVENT_TYPES, credentialDomain } from "../hcs/credential-envelope";
import { NETWORKS } from "../networks";
import { RelayRpcError, createRelayWallet } from "./relay-wallet";

const RPC = NETWORKS.testnet.rpcUrl;
const ADDRESS = ISSUER_SIGNER.address.toLowerCase();

type Answer = { result?: unknown; error?: unknown; status?: number; raw?: string };

function relay(answers: Record<string, Answer | ((params: unknown[]) => Answer)>) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const { method, params, id } = JSON.parse(String(init?.body));
    calls.push({ method, params });
    const entry = answers[method];
    const answer =
      typeof entry === "function" ? entry(params) : (entry ?? { error: { code: -32601, message: "nope" } });
    if (answer.raw !== undefined) return new Response(answer.raw, { status: answer.status ?? 200 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...answer }), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  const wallet = createRelayWallet({
    privateKey: ISSUER_SIGNER.privateKey,
    rpcUrl: RPC,
    chainId: 296,
    fetch: fetchImpl,
  });
  return { wallet, calls };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as RelayRpcError;
  }
  throw new Error("expected a failure");
};

describe("createRelayWallet", () => {
  it("holds one account and never asks the relay for it", async () => {
    const { wallet, calls } = relay({});
    expect(wallet.address).toBe(ADDRESS);
    expect(await wallet.request({ method: "eth_accounts" })).toEqual([ADDRESS]);
    expect(await wallet.request({ method: "eth_requestAccounts" })).toEqual([ADDRESS]);
    expect(calls).toEqual([]);
  });

  it("signs EIP-712 typed data locally, like a browser wallet", async () => {
    const { wallet } = relay({});
    const event = makeCredentialEvent();
    const payload = credentialEventTypedData(event, DOMAIN);
    const signature = await wallet.request({
      method: "eth_signTypedData_v4",
      params: [ADDRESS, JSON.stringify(payload)],
    });
    expect(
      verifyTypedData(credentialDomain(DOMAIN), CREDENTIAL_EVENT_TYPES, event, String(signature)).toLowerCase(),
    ).toBe(ADDRESS);
    const other = await failure(
      wallet.request({ method: "eth_signTypedData_v4", params: ["0x" + "99".repeat(20), JSON.stringify(payload)] }),
    );
    expect(other.code).toBe(4100);
  });

  it("signs a legacy transaction with the relay's nonce, gas price and estimate plus headroom", async () => {
    const { wallet, calls } = relay({
      eth_getTransactionCount: { result: "0x7" },
      eth_gasPrice: { result: "0xa5a7ab5c00" },
      eth_estimateGas: { result: "0x186a0" },
      eth_sendRawTransaction: params => ({ result: Transaction.from(String(params[0])).hash }),
    });
    const data = new Interface(CredentialRegistryAbi).encodeFunctionData("revoke", [`0x${"11".repeat(32)}`]);
    const hash = await wallet.request({
      method: "eth_sendTransaction",
      params: [{ from: ADDRESS, to: REGISTRY, data }],
    });
    const raw = calls.find(c => c.method === "eth_sendRawTransaction")!.params[0];
    const tx = Transaction.from(String(raw));
    expect(tx).toMatchObject({ type: 0, nonce: 7, data, chainId: 296n, gasLimit: 120_000n, gasPrice: 0xa5a7ab5c00n });
    expect(tx.from!.toLowerCase()).toBe(ADDRESS);
    expect(tx.to!.toLowerCase()).toBe(REGISTRY);
    expect(hash).toBe(tx.hash);
    expect(calls.find(c => c.method === "eth_getTransactionCount")!.params).toEqual([ADDRESS, "pending"]);
  });

  it("refuses a transaction from another account or without a destination", async () => {
    const { wallet } = relay({});
    expect(
      (
        await failure(
          wallet.request({ method: "eth_sendTransaction", params: [{ from: "0x" + "99".repeat(20), to: REGISTRY }] }),
        )
      ).code,
    ).toBe(4100);
    expect((await failure(wallet.request({ method: "eth_sendTransaction", params: [{}] }))).code).toBe(-32602);
  });

  it("rejects malformed relay answers", async () => {
    const { wallet } = relay({
      eth_getTransactionCount: { result: "seven" },
      eth_gasPrice: { result: "0x1" },
      eth_estimateGas: { result: "0x1" },
    });
    const error = await failure(wallet.request({ method: "eth_sendTransaction", params: [{ to: REGISTRY }] }));
    expect(error.code).toBe("SERVER_ERROR");
  });

  it("passes other methods through and surfaces relay errors with their code and revert data", async () => {
    const revertData = new Interface(CredentialRegistryAbi).encodeErrorResult("AlreadyIssued", [
      `0x${"11".repeat(32)}`,
      5n,
    ]);
    const { wallet } = relay({
      eth_chainId: { result: "0x128" },
      eth_call: { error: { code: 3, message: "execution reverted", data: revertData } },
      eth_getTransactionReceipt: { error: {} },
    });
    expect(await wallet.request({ method: "eth_chainId" })).toBe("0x128");
    const reverted = await failure(
      wallet.request({ method: "eth_call", params: [{ to: REGISTRY, data: "0x" }, "latest"] }),
    );
    expect(reverted).toMatchObject({ name: "RelayRpcError", code: 3, data: revertData });
    expect(classifyIssuerError(reverted).code).toBe("AlreadyIssued");
    const generic = await failure(wallet.request({ method: "eth_getTransactionReceipt", params: ["0x"] }));
    expect(generic).toMatchObject({ code: -32603, message: "JSON-RPC error" });
  });

  it("classifies non-JSON and HTTP failures", async () => {
    const { wallet } = relay({
      eth_chainId: { raw: "<html>bad gateway</html>", status: 502 },
      eth_blockNumber: { result: "0x1", status: 429 },
    });
    expect((await failure(wallet.request({ method: "eth_chainId" }))).code).toBe("SERVER_ERROR");
    const limited = await failure(wallet.request({ method: "eth_blockNumber" }));
    expect(limited.code).toBe(429);
    expect(classifyIssuerError(limited).category).toBe("rpc_unavailable");
  });
});
