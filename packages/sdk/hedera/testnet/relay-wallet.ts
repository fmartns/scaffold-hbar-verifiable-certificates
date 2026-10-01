/**
 * An EIP-1193 provider for Node scripts: a secp256k1 key signs locally (EIP-712 typed data and transactions) and every
 * other method goes to the JSON-RPC relay. It lets `yarn verify:testnet` drive the same `runIssuance`/`runRevocation`
 * the browser console uses, with a key in place of a browser wallet. The key never leaves this closure: it is not
 * returned, logged or put in an error.
 */
import { Wallet, getAddress } from "ethers";
import type { Eip1193Like } from "../credentials/issuer-flow";
import type { Hex } from "../hcs/envelope";

export interface RelayWalletOptions {
  /** 32-byte secp256k1 private key, hex. */
  privateKey: string;
  rpcUrl: string;
  chainId: number;
  fetch?: typeof fetch;
  /** Per request. Default 20 s. */
  timeoutMs?: number;
  /** Gas limit = `eth_estimateGas` × this / 100. Default 120: Hedera charges at least 80% of the limit, keep it tight. */
  gasHeadroomPercent?: number;
}

export interface RelayWallet extends Eip1193Like {
  /** Lowercase EVM address of the key. */
  readonly address: Hex;
}

/** A JSON-RPC error answered by the relay, with its `code` and revert `data` (decoded by `classifyIssuerError`). */
export class RelayRpcError extends Error {
  readonly code: number | string;
  readonly data?: unknown;
  constructor(message: string, code: number | string, data?: unknown) {
    super(message);
    this.name = "RelayRpcError";
    this.code = code;
    this.data = data;
  }
}

interface TransactionRequest {
  from?: string;
  to?: string;
  data?: string;
}

const toBigInt = (value: unknown, what: string): bigint => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new RelayRpcError(`The relay answered ${what} with an unexpected value.`, "SERVER_ERROR");
  }
  return BigInt(value);
};

export function createRelayWallet(options: RelayWalletOptions): RelayWallet {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const headroom = BigInt(options.gasHeadroomPercent ?? 120);
  const wallet = new Wallet(options.privateKey);
  const address = wallet.address.toLowerCase() as Hex;
  let id = 0;

  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetchImpl(options.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    try {
      body = await response.json();
    } catch {
      throw new RelayRpcError(`The relay answered HTTP ${response.status} without JSON-RPC.`, "SERVER_ERROR");
    }
    if (body.error) {
      throw new RelayRpcError(body.error.message ?? "JSON-RPC error", body.error.code ?? -32603, body.error.data);
    }
    if (!response.ok) throw new RelayRpcError(`The relay answered HTTP ${response.status}.`, response.status);
    return body.result;
  }

  const requireSelf = (account: unknown) => {
    if (typeof account !== "string" || account.toLowerCase() !== address) {
      throw new RelayRpcError("The requested account is not the one this wallet holds.", 4100);
    }
  };

  async function sendTransaction(tx: TransactionRequest): Promise<unknown> {
    requireSelf(tx.from ?? address);
    if (!tx.to) throw new RelayRpcError("A transaction needs a `to` address.", -32602);
    const to = getAddress(tx.to);
    const data = tx.data ?? "0x";
    const [nonce, gasPrice, estimate] = await Promise.all([
      rpc("eth_getTransactionCount", [address, "pending"]),
      rpc("eth_gasPrice", []),
      rpc("eth_estimateGas", [{ from: address, to, data }]),
    ]);
    const signed = await wallet.signTransaction({
      type: 0,
      chainId: options.chainId,
      nonce: Number(toBigInt(nonce, "eth_getTransactionCount")),
      gasPrice: toBigInt(gasPrice, "eth_gasPrice"),
      gasLimit: (toBigInt(estimate, "eth_estimateGas") * headroom) / 100n,
      to,
      data,
      value: 0n,
    });
    return rpc("eth_sendRawTransaction", [signed]);
  }

  return {
    address,
    async request({ method, params }) {
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [address];
        case "eth_signTypedData_v4": {
          requireSelf(params?.[0]);
          const payload = JSON.parse(String(params?.[1]));
          const types = { ...payload.types };
          delete types.EIP712Domain;
          return wallet.signTypedData(payload.domain, types, payload.message);
        }
        case "eth_sendTransaction":
          return sendTransaction((params?.[0] ?? {}) as TransactionRequest);
        default:
          return rpc(method, params ?? []);
      }
    },
  };
}
