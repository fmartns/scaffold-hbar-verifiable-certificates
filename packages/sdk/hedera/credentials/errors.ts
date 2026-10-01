/**
 * Normalized errors of the issuer flow (issue and revoke). A UI branches on `category` and shows `title`, `message`
 * and `remediation` as they are: every failure scenario of the console has its own category and wording, never a
 * generic "something went wrong". Browser-safe, duck-typed (EIP-1193, ethers, relay and HCS publisher shapes), and the
 * messages never echo raw provider text, which may carry URLs or user input.
 */
import { decodeBytes32String } from "ethers";
import type { HcsPublishFailure } from "../hcs/errors";
import { decodeRegistryError } from "./registry-calls";
import type { DecodedRegistryError } from "./registry-calls";

export type IssuerErrorCategory =
  /** The JSON-RPC relay, the Mirror Node or the console server could not be reached. */
  | "rpc_unavailable"
  /** A step did not finish in time; the outcome may still land (reconcile by the ids in the error). */
  | "timeout"
  /** No wallet, no connected account, or the wallet lost its connection. */
  | "wallet_disconnected"
  /** The wallet is on another chain than the configured network. */
  | "wrong_network"
  /** The person declined the request in the wallet. */
  | "rejected"
  /** Hedera answered with a failure status (HCS publish, relay precheck, gas, balance…). */
  | "hedera"
  /** The namespace is not registered or not active, or the wallet is not its registered signer. */
  | "issuer_not_registered"
  /** The registry refused the call for a business reason (duplicate, expired, already revoked…). */
  | "contract_rejected"
  /** The form or the request is invalid; nothing was sent. */
  | "invalid_input"
  /** The server is missing configuration (registry, topic, operator). */
  | "not_configured"
  | "unknown";

export interface IssuerError {
  category: IssuerErrorCategory;
  /** Stable machine code, e.g. `UnknownIssuer`, `INSUFFICIENT_PAYER_BALANCE`, `WALLET_REJECTED`. */
  code: string;
  title: string;
  message: string;
  remediation: string;
  hederaStatus?: string;
  /** Hedera transaction id of an HCS publish, when known. */
  transactionId?: string;
  /** EVM transaction hash of a registry call, when known. */
  transactionHash?: string;
  /** Per-field problems, for `invalid_input`. */
  issues?: { field: string; message: string }[];
}

export class IssuerFlowError extends Error {
  readonly issuerError: IssuerError;
  constructor(issuerError: IssuerError) {
    super(`[${issuerError.category}/${issuerError.code}] ${issuerError.message}`);
    this.name = "IssuerFlowError";
    this.issuerError = issuerError;
  }
}

export function isIssuerFlowError(value: unknown): value is IssuerFlowError {
  return value instanceof IssuerFlowError || (value as { name?: unknown } | null)?.name === "IssuerFlowError";
}

/** Thrown by the flow's own deadlines (receipt polling, dry-runs, HTTP calls). */
export class IssuerTimeoutError extends Error {
  readonly step: string;
  readonly transactionHash?: string;
  constructor(step: string, timeoutMs: number, transactionHash?: string) {
    super(`${step} did not finish within ${timeoutMs} ms`);
    this.name = "IssuerTimeoutError";
    this.step = step;
    this.transactionHash = transactionHash;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Registry custom errors
// ---------------------------------------------------------------------------------------------------------------------

const short = (value: string | undefined) =>
  value && value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : (value ?? "");

const fieldName = (bytes32: string | undefined) => {
  try {
    return bytes32 ? decodeBytes32String(bytes32) : "a field";
  } catch {
    return "a field";
  }
};

const dateOf = (unixSeconds: string | undefined) =>
  unixSeconds && /^\d+$/.test(unixSeconds) ? new Date(Number(unixSeconds) * 1000).toISOString() : "an earlier time";

export function describeRegistryError(decoded: DecodedRegistryError): IssuerError {
  const a = decoded.args;
  const base = { code: decoded.name };
  switch (decoded.name) {
    case "UnknownIssuer":
      return {
        ...base,
        category: "issuer_not_registered",
        title: "Issuer not registered",
        message: `The issuer namespace ${short(a.issuer)} is not registered in CredentialRegistry.`,
        remediation:
          "Check the organization name (it is hashed in lowercase). If it is right, ask the registry admin to call registerIssuer for this namespace with your wallet address as signer.",
      };
    case "InactiveIssuer":
      return {
        ...base,
        category: "issuer_not_registered",
        title: "Issuer deactivated",
        message: `The issuer namespace ${short(a.issuer)} is registered but deactivated by the registry admin.`,
        remediation: "Contact the registry admin. Issuance and key rotation stay blocked until it is reactivated.",
      };
    case "UnauthorizedSigner":
      return {
        ...base,
        category: "issuer_not_registered",
        title: "Wallet is not the issuer's signer",
        message: `The connected wallet ${short(a.recovered)} is not the registered signer (${short(a.expected)}) of this issuer.`,
        remediation: "Connect the wallet registered as this issuer's signer, or check the organization name.",
      };
    case "InvalidSignature":
      return {
        ...base,
        category: "contract_rejected",
        title: "Invalid signature",
        message: "The registry could not recover a signer from the signature.",
        remediation: "Sign again. If it persists, your wallet may not support EIP-712 (eth_signTypedData_v4).",
      };
    case "AlreadyIssued":
      return {
        ...base,
        category: "contract_rejected",
        title: "Credential already issued",
        message: `This credential (${short(a.credentialId)}) was already issued on ${dateOf(a.issuedAt)}.`,
        remediation: "Nothing to do: the credential exists. Use a new reference to issue a different credential.",
      };
    case "ConflictingCredential":
      return {
        ...base,
        category: "contract_rejected",
        title: "Conflicting credential",
        message: `The reference is already registered (${short(a.credentialId)}) with different content.`,
        remediation:
          "A credential ID is permanent and its content cannot change. Use a new reference, or revoke the existing one first if it was wrong.",
      };
    case "Expired":
      return {
        ...base,
        category: "contract_rejected",
        title: "Signature window expired",
        message: "The signed issuance expired before it reached the registry.",
        remediation: "Issue again (a fresh signature is created), or use a longer signature window.",
      };
    case "SignedInFuture":
      return {
        ...base,
        category: "contract_rejected",
        title: "Clock ahead of the network",
        message: "The signature is dated more than 30 s in the future relative to the network.",
        remediation: "Synchronize your computer's clock and issue again.",
      };
    case "ValidityWindowTooLong":
      return {
        ...base,
        category: "contract_rejected",
        title: "Signature window too long",
        message: `The signature window (${a.window} s) exceeds this issuer's maximum (${a.max} s).`,
        remediation: "Choose a shorter signature window.",
      };
    case "Paused":
      return {
        ...base,
        category: "contract_rejected",
        title: "Issuance paused",
        message: "The registry admin has paused issuance. Revocation still works.",
        remediation: "Try again after the registry is unpaused.",
      };
    case "SubmitterMismatch":
      return {
        ...base,
        category: "contract_rejected",
        title: "Wrong submitter",
        message: `The issuance is pinned to ${short(a.expected)} but was sent by ${short(a.actual)}.`,
        remediation: "Send the transaction from the wallet that signed, without switching accounts in between.",
      };
    case "UnsupportedVersion":
    case "InvalidField":
      return {
        ...base,
        category: "contract_rejected",
        title: "Malformed credential",
        message:
          decoded.name === "InvalidField"
            ? `The registry rejected ${fieldName(a.field)} as invalid.`
            : `The registry does not support credential version ${a.got}.`,
        remediation: "Update the console to the version that matches the deployed registry.",
      };
    case "UnknownCredential":
      return {
        ...base,
        category: "contract_rejected",
        title: "Credential not found",
        message: `No credential with ID ${short(a.credentialId)} was issued in this registry.`,
        remediation: "Check the credential ID and the selected network.",
      };
    case "AlreadyRevoked":
      return {
        ...base,
        category: "contract_rejected",
        title: "Already revoked",
        message: `This credential was already revoked on ${dateOf(a.revokedAt)}.`,
        remediation: "Nothing to do: revocation is final.",
      };
    case "UnauthorizedRevoker":
      return {
        ...base,
        category: "issuer_not_registered",
        title: "Not allowed to revoke",
        message: `The connected wallet ${short(a.caller)} is not the current signer of the issuer that issued this credential (or the issuer is deactivated).`,
        remediation: "Connect the wallet registered as the issuing namespace's signer.",
      };
    case "Error":
      return {
        ...base,
        category: "contract_rejected",
        title: "Transaction reverted",
        message: `The contract reverted: ${a.reason.slice(0, 200)}`,
        remediation: "Check the inputs and the deployed registry address.",
      };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------------------------------

/** Hedera response codes the relay surfaces in JSON-RPC error messages, mapped to a remediation. */
const HEDERA_STATUSES: Record<string, string> = {
  INSUFFICIENT_PAYER_BALANCE: "Fund the wallet with HBAR (testnet faucet: portal.hedera.com).",
  INSUFFICIENT_ACCOUNT_BALANCE: "Fund the wallet with HBAR (testnet faucet: portal.hedera.com).",
  INSUFFICIENT_TX_FEE: "Retry and accept the gas price the wallet proposes.",
  INSUFFICIENT_GAS: "Retry with a higher gas limit.",
  MAX_GAS_LIMIT_EXCEEDED: "Lower the gas limit in the wallet (Hedera caps it at 15M per transaction).",
  WRONG_NONCE: "Reset the account's pending transactions in the wallet, then retry.",
  CONTRACT_REVERT_EXECUTED: "The contract reverted; see the reason on HashScan.",
  INVALID_CONTRACT_ID: "Check HEDERA_CREDENTIAL_REGISTRY_ADDRESS and the selected network.",
  INVALID_SIGNATURE: "The transaction signature was rejected; reconnect the wallet and retry.",
  PAYER_ACCOUNT_NOT_FOUND: "The wallet address has no Hedera account yet: send it some HBAR first.",
  DUPLICATE_TRANSACTION: "The same transaction was already submitted; check HashScan before retrying.",
  BUSY: "The network is busy. Retry in a few seconds.",
  PLATFORM_NOT_ACTIVE: "The network is not accepting transactions right now. Retry later.",
  TRANSACTION_EXPIRED: "The transaction expired before reaching consensus. Retry.",
};
const HEDERA_STATUS_PATTERN = new RegExp(`\\b(${Object.keys(HEDERA_STATUSES).join("|")})\\b`);

const NETWORK_TEXT =
  /(failed to fetch|fetch failed|networkerror|network error|load failed|econnrefused|econnreset|enotfound|eai_again|socket hang up|bad gateway|service unavailable|gateway timeout|could not coalesce|missing response|server error)/i;
const TIMEOUT_TEXT = /(timed? ?out|timeout|deadline exceeded)/i;

interface Shape {
  code?: unknown;
  name?: unknown;
  message?: unknown;
  shortMessage?: unknown;
  status?: unknown;
  data?: unknown;
  error?: unknown;
  info?: unknown;
  cause?: unknown;
}

function messageText(error: unknown, depth = 0): string {
  if (depth > 4 || typeof error !== "object" || error === null) return typeof error === "string" ? error : "";
  const e = error as Shape;
  return [e.shortMessage, e.message, messageText(e.error, depth + 1), messageText(e.info, depth + 1)]
    .concat(messageText(e.cause, depth + 1))
    .filter(part => typeof part === "string" && part)
    .join(" | ");
}

function codesOf(error: unknown, depth = 0): unknown[] {
  if (depth > 4 || typeof error !== "object" || error === null) return [];
  const e = error as Shape;
  return [e.code, ...codesOf(e.error, depth + 1), ...codesOf(e.info, depth + 1), ...codesOf(e.cause, depth + 1)];
}

/** Revert data nested anywhere a provider puts it (`data`, `data.data`, `error.data`, `info.error.data`, …). */
export function findRevertData(error: unknown, depth = 0): string | null {
  if (depth > 5 || error === null || error === undefined) return null;
  if (typeof error === "string") return /^0x[0-9a-fA-F]{8,}$/.test(error) ? error : null;
  if (typeof error !== "object") return null;
  const e = error as Shape & { revert?: unknown };
  for (const candidate of [e.data, e.error, e.info, e.cause]) {
    const found = findRevertData(candidate, depth + 1);
    if (found) return found;
  }
  if (typeof e.message === "string") {
    const match = /(0x[0-9a-fA-F]{8,})/.exec(e.message);
    if (match && decodeRegistryError(match[1])) return match[1];
  }
  return null;
}

/** Maps an HCS publisher failure (returned by the console server) to the issuer taxonomy. */
export function fromHcsPublishFailure(failure: HcsPublishFailure): IssuerError {
  const ids = {
    ...(failure.transactionId && { transactionId: failure.transactionId }),
    ...(failure.hederaStatus && { hederaStatus: failure.hederaStatus }),
  };
  switch (failure.code) {
    case "TIMEOUT":
      return {
        category: "timeout",
        code: "HCS_TIMEOUT",
        title: "HCS publication timed out",
        message: "The evidence was sent to HCS but no consensus receipt arrived in time. Nothing was registered.",
        remediation:
          "Look the transaction up on HashScan by its id before retrying; a second publication is harmless (the audit deduplicates it).",
        ...ids,
      };
    case "NETWORK_UNAVAILABLE":
      return {
        category: "rpc_unavailable",
        code: "HCS_NETWORK_UNAVAILABLE",
        title: "Hedera network unreachable",
        message: "The server could not reach a Hedera consensus node to publish the evidence. Nothing was registered.",
        remediation: "Retry in a few seconds. If it persists, check the server's connectivity and HEDERA_NETWORK.",
        ...ids,
      };
    case "CONFIG_INVALID":
      return {
        category: "not_configured",
        code: "HCS_CONFIG_INVALID",
        title: "HCS publisher not configured",
        message: "The server cannot publish evidence: its operator or topic configuration is missing or invalid.",
        remediation: "Run `yarn setup` and `yarn hcs:topic` on the server, then restart it.",
      };
    case "INVALID_EVENT":
      return {
        category: "invalid_input",
        code: "HCS_INVALID_EVENT",
        title: "Invalid credential evidence",
        message: failure.message,
        remediation: failure.remediation,
        ...(failure.issues && { issues: failure.issues.map(i => ({ field: i.field, message: i.message })) }),
      };
    default:
      return {
        category: "hedera",
        code: failure.hederaStatus ?? failure.code,
        title: "Hedera rejected the HCS publication",
        message: failure.hederaStatus
          ? `Hedera returned ${failure.hederaStatus} for the evidence message. Nothing was registered.`
          : `The evidence publication failed (${failure.code}). Nothing was registered.`,
        remediation: failure.remediation,
        ...ids,
      };
  }
}

/** Turns anything thrown by a wallet, the relay, `fetch` or the flow itself into an {@link IssuerError}. */
export function classifyIssuerError(error: unknown): IssuerError {
  if (isIssuerFlowError(error)) return (error as IssuerFlowError).issuerError;

  if ((error as Shape | null)?.name === "IssuerTimeoutError") {
    const t = error as IssuerTimeoutError;
    return {
      category: "timeout",
      code: "TIMEOUT",
      title: "Timed out",
      message: `${t.step} did not finish in time.`,
      remediation: t.transactionHash
        ? "The transaction may still be confirmed: check it on HashScan before retrying."
        : "Check your connection and retry.",
      ...(t.transactionHash && { transactionHash: t.transactionHash }),
    };
  }

  const revert = findRevertData(error);
  const decoded = revert ? decodeRegistryError(revert) : null;
  if (decoded) return describeRegistryError(decoded);

  const codes = codesOf(error);
  const text = messageText(error);

  if (codes.includes(4001) || codes.includes("ACTION_REJECTED") || /user (rejected|denied)/i.test(text)) {
    return {
      category: "rejected",
      code: "WALLET_REJECTED",
      title: "Rejected in the wallet",
      message: "The request was rejected in the wallet. Nothing was sent.",
      remediation: "Start again and approve the request in the wallet to continue.",
    };
  }
  if (codes.includes(-32002)) {
    return {
      category: "rejected",
      code: "WALLET_REQUEST_PENDING",
      title: "Wallet request pending",
      message: "The wallet already has a request waiting for an answer.",
      remediation: "Open the wallet, answer or dismiss the pending request, then retry.",
    };
  }
  if (codes.some(c => c === 4100 || c === 4900 || c === 4901)) {
    return {
      category: "wallet_disconnected",
      code: "WALLET_DISCONNECTED",
      title: "Wallet disconnected",
      message: "The wallet is not connected to this site or lost its connection to the network.",
      remediation: "Reconnect the wallet and retry.",
    };
  }

  const status =
    HEDERA_STATUS_PATTERN.exec(text)?.[1] ?? (/insufficient funds/i.test(text) ? "INSUFFICIENT_PAYER_BALANCE" : null);
  if (status) {
    return {
      category: "hedera",
      code: status,
      hederaStatus: status,
      title: "Hedera rejected the transaction",
      message: `Hedera answered ${status}.`,
      remediation: HEDERA_STATUSES[status],
    };
  }

  const name = typeof (error as Shape | null)?.name === "string" ? (error as Shape).name : "";
  if (name === "TimeoutError" || codes.includes("TIMEOUT") || TIMEOUT_TEXT.test(text)) {
    return {
      category: "timeout",
      code: "TIMEOUT",
      title: "Timed out",
      message: "The network did not answer in time.",
      remediation: "Check your connection and retry. A transaction already sent may still be confirmed.",
    };
  }
  if (
    name === "TypeError" ||
    codes.some(c => c === "NETWORK_ERROR" || c === "SERVER_ERROR" || c === -32005 || c === 429) ||
    NETWORK_TEXT.test(text) ||
    (codes.includes(-32603) && !revert)
  ) {
    return {
      category: "rpc_unavailable",
      code: "RPC_UNAVAILABLE",
      title: "Network unreachable",
      message: "The JSON-RPC relay (or the console server) could not be reached or answered with an error.",
      remediation: "Check your connection and retry. If it persists, the relay may be rate-limiting: wait a minute.",
    };
  }

  return {
    category: "unknown",
    code: "UNKNOWN",
    title: "Unexpected error",
    message: "The operation failed for a reason that could not be classified.",
    remediation: "Open the browser console for details and report it if it persists.",
  };
}

export function walletDisconnectedError(): IssuerFlowError {
  return new IssuerFlowError({
    category: "wallet_disconnected",
    code: "WALLET_NOT_CONNECTED",
    title: "Wallet not connected",
    message: "Connect the issuer's wallet to sign and send credentials.",
    remediation: "Click “Connect wallet” and approve the connection.",
  });
}

export function wrongNetworkError(expectedChainId: number, reported: string | null): IssuerFlowError {
  return new IssuerFlowError({
    category: "wrong_network",
    code: "WRONG_NETWORK",
    title: "Wrong network",
    message: `The wallet is on chain ${reported ? Number(reported) : "unknown"}, but this console targets chain ${expectedChainId}.`,
    remediation: "Switch the wallet to the configured network and retry.",
  });
}
