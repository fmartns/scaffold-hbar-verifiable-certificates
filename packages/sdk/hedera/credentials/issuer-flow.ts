/**
 * The issuer's issuance and revocation flows, in the order ADR-001 D11 requires: build and sign, dry-run against the
 * registry, publish the evidence to HCS and capture its consensus receipt, and only then send the transaction. The
 * order lives here, once, so no UI can reorder it.
 *
 * Browser-safe. The wallet (EIP-1193) is the issuer's registered signer and pays the registry transaction; the backend
 * port publishes to HCS with the operator key server-side (the key never reaches the browser).
 */
import type { CredentialAuditReport } from "../audit/types";
import { buildCredentialMessage } from "../hcs/credential-envelope";
import type { CredentialEvent, CredentialRevocation } from "../hcs/credential-envelope";
import type { Hex } from "../hcs/envelope";
import {
  IssuerFlowError,
  IssuerTimeoutError,
  classifyIssuerError,
  describeRegistryError,
  walletDisconnectedError,
  wrongNetworkError,
} from "./errors";
import { buildCredentialDraft, buildRevocationDraft } from "./fields";
import type { CredentialDraftInput, RevocationReason } from "./fields";
import type { CredentialDocument } from "./schema";
import { SIMULATION_HCS_REF, encodeIssueCall, encodeRevokeCall } from "./registry-calls";
import {
  credentialEventTypedData,
  credentialRevocationTypedData,
  serializeCredentialEvent,
  serializeCredentialRevocation,
} from "./signing";

// ---------------------------------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------------------------------

export interface Eip1193Like {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** Body of the publish request: the signed message, JSON-safe. The server re-validates everything. */
export type PublishCredentialRequest =
  | { kind: "issuance"; event: Record<string, string | number>; signature: string }
  | { kind: "revocation"; revocation: Record<string, string | number>; signature: string };

/** What the server returns after HCS consensus (JSON-safe). Persist `transactionId` and `hashscanUrl`. */
export interface CredentialPublishReceipt {
  kind: "issuance" | "revocation";
  credentialId: Hex;
  digest: Hex;
  signer: Hex;
  topicId: string;
  network: string;
  transactionId: string;
  mirrorTransactionId: string;
  hcsRef: { sequence: string; consensusTimestampNs: string };
  consensusTimestamp: string;
  hashscanUrl: string | null;
  hashscanTopicUrl: string | null;
  mirrorMessageUrl: string;
  messageSha256: Hex;
  recordedAt: string;
}

export interface CredentialStatusView {
  credentialId: Hex;
  status: "not_found" | "issued" | "revoked";
  issuer: Hex;
  signer: Hex;
  issuedAt: string;
  revokedAt: string;
}

/** A value as it travels in JSON: every `bigint` becomes a decimal string. */
export type JsonSafe<T> = T extends bigint
  ? string
  : T extends (infer U)[]
    ? JsonSafe<U>[]
    : T extends object
      ? { [K in keyof T]: JsonSafe<T[K]> }
      : T;

/** The shared audit report (#10) as the console server sends it. */
export type CredentialAuditReportJson = JsonSafe<CredentialAuditReport>;

/** Public, secret-free settings the console page sends to the browser. */
export interface IssuerConsoleSettings {
  configured: boolean;
  issues: { variable: string; message: string }[];
  network: string | null;
  chainId: number | null;
  registryAddress: string | null;
  topicId: string | null;
  hashscanUrl: string | null;
}

/** Server side of the flow. Implementations throw {@link IssuerFlowError} with the server's classification. */
export interface IssuerBackend {
  publish(request: PublishCredentialRequest): Promise<CredentialPublishReceipt>;
  status(credentialId: string): Promise<CredentialStatusView>;
}

export interface IssuerFlowContext {
  provider: Eip1193Like | null | undefined;
  backend: IssuerBackend;
  chainId: number;
  registryAddress: string;
  /** Milliseconds since the epoch. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Deadline of the registry transaction's receipt. Default 90 s. */
  receiptTimeoutMs?: number;
  receiptPollMs?: number;
  /** Deadline of a dry-run (`eth_call`). Default 20 s. */
  callTimeoutMs?: number;
}

export interface RegistryTransaction {
  transactionHash: Hex;
  blockNumber: string;
  from: Hex;
}

export type IssuanceStep = "build" | "sign" | "simulate" | "publish" | "register" | "confirm";
export type RevocationStep = "status" | "sign" | "simulate" | "publish" | "revoke" | "confirm";

export interface IssuanceOutcome {
  credentialId: Hex;
  event: CredentialEvent;
  /** Hand it to the holder; the console never stores it. */
  subjectSalt: Hex;
  /** The holder's document (contains the holder identifier): in memory only, never sent or stored. */
  document: CredentialDocument;
  signature: Hex;
  digest: Hex;
  hcs: CredentialPublishReceipt;
  registration: RegistryTransaction;
}

export interface RevocationOutcome {
  credentialId: Hex;
  revocation: CredentialRevocation;
  signature: Hex;
  hcs: CredentialPublishReceipt;
  registration: RegistryTransaction;
}

export type ProgressListener<S extends string> = (event: {
  step: S;
  state: "active" | "done";
  detail?: Record<string, unknown>;
}) => void;

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function withDeadline<T>(promise: Promise<T>, ms: number, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IssuerTimeoutError(step, ms)), ms);
  });
  promise.catch(() => undefined);
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Re-throws anything as a classified {@link IssuerFlowError}. */
async function step<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw error instanceof IssuerFlowError ? error : new IssuerFlowError(classifyIssuerError(error));
  }
}

/** The connected account on the target chain. Never prompts (`eth_accounts`). */
export async function requireIssuerAccount(ctx: Pick<IssuerFlowContext, "provider" | "chainId">): Promise<Hex> {
  const provider = ctx.provider;
  if (!provider) throw walletDisconnectedError();
  const accounts = await step(() => provider.request({ method: "eth_accounts" }));
  const account = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0].toLowerCase() : null;
  if (!account) throw walletDisconnectedError();
  const chain = await step(() => provider.request({ method: "eth_chainId" }));
  const reported = typeof chain === "string" ? chain : null;
  if (!reported || !/^0x[0-9a-f]+$/i.test(reported) || Number(BigInt(reported)) !== ctx.chainId) {
    throw wrongNetworkError(ctx.chainId, reported);
  }
  return account as Hex;
}

async function signTypedData(provider: Eip1193Like, account: Hex, payload: unknown): Promise<Hex> {
  const signature = await step(() =>
    provider.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(payload)] }),
  );
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new IssuerFlowError({
      category: "unknown",
      code: "BAD_SIGNATURE",
      title: "Unexpected signature",
      message: "The wallet returned something that is not a 65-byte signature.",
      remediation: "Use a wallet that supports EIP-712 (eth_signTypedData_v4).",
    });
  }
  return signature.toLowerCase() as Hex;
}

function signerMismatch(account: Hex, signer: Hex): IssuerFlowError {
  return new IssuerFlowError({
    category: "issuer_not_registered",
    code: "SIGNER_MISMATCH",
    title: "Signature from another key",
    message: `The wallet signed with ${signer}, not with the connected account ${account}.`,
    remediation: "Select the issuer account in the wallet and retry.",
  });
}

async function dryRun(ctx: IssuerFlowContext, provider: Eip1193Like, from: Hex, data: Hex): Promise<void> {
  await step(() =>
    withDeadline(
      provider.request({ method: "eth_call", params: [{ from, to: ctx.registryAddress, data }, "latest"] }),
      ctx.callTimeoutMs ?? 20_000,
      "The registry dry-run",
    ),
  );
}

interface ReceiptLike {
  status?: unknown;
  blockNumber?: unknown;
  from?: unknown;
}

async function sendAndConfirm(
  ctx: IssuerFlowContext,
  provider: Eip1193Like,
  from: Hex,
  data: Hex,
  onSent: (hash: Hex) => void,
): Promise<RegistryTransaction> {
  const hash = await step(() =>
    provider.request({ method: "eth_sendTransaction", params: [{ from, to: ctx.registryAddress, data }] }),
  );
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new IssuerFlowError({
      category: "unknown",
      code: "BAD_TRANSACTION_HASH",
      title: "Unexpected wallet answer",
      message: "The wallet did not return a transaction hash.",
      remediation: "Check the wallet's activity tab before retrying.",
    });
  }
  const transactionHash = hash.toLowerCase() as Hex;
  onSent(transactionHash);

  const now = ctx.now ?? Date.now;
  const sleep = ctx.sleep ?? defaultSleep;
  const timeoutMs = ctx.receiptTimeoutMs ?? 90_000;
  const started = now();
  for (;;) {
    let receipt: ReceiptLike | null = null;
    try {
      receipt = (await provider.request({
        method: "eth_getTransactionReceipt",
        params: [transactionHash],
      })) as ReceiptLike | null;
    } catch {
      // A transient relay failure while polling is not a verdict: keep polling until the deadline.
    }
    if (receipt) {
      if (receipt.status === "0x1" || receipt.status === 1) {
        return {
          transactionHash,
          blockNumber: String(receipt.blockNumber ?? ""),
          from: String(receipt.from ?? from).toLowerCase() as Hex,
        };
      }
      // Reverted: replay the call to recover the reason; fall back to Hedera's generic status.
      try {
        await provider.request({ method: "eth_call", params: [{ from, to: ctx.registryAddress, data }, "latest"] });
      } catch (error) {
        const classified = classifyIssuerError(error);
        if (classified.category === "contract_rejected" || classified.category === "issuer_not_registered") {
          throw new IssuerFlowError({ ...classified, transactionHash });
        }
      }
      throw new IssuerFlowError({
        ...classifyIssuerError(new Error("CONTRACT_REVERT_EXECUTED")),
        transactionHash,
      });
    }
    if (now() - started >= timeoutMs) {
      throw new IssuerFlowError({
        ...classifyIssuerError(
          new IssuerTimeoutError("Waiting for the registry transaction", timeoutMs, transactionHash),
        ),
      });
    }
    await sleep(ctx.receiptPollMs ?? 1_500);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------------------------------------------------

export async function runIssuance(
  input: CredentialDraftInput,
  ctx: IssuerFlowContext,
  onProgress: ProgressListener<IssuanceStep> = () => undefined,
): Promise<IssuanceOutcome> {
  const domain = { chainId: ctx.chainId, verifyingContract: ctx.registryAddress };

  onProgress({ step: "build", state: "active" });
  const account = await requireIssuerAccount(ctx);
  const provider = ctx.provider as Eip1193Like;
  const draft = buildCredentialDraft(input, {
    nowSeconds: Math.floor((ctx.now ?? Date.now)() / 1000),
    submitter: account,
  });
  if (!draft.ok) {
    throw new IssuerFlowError({
      category: "invalid_input",
      code: "INVALID_INPUT",
      title: "Check the form",
      message: "Some fields are missing or invalid. Nothing was signed or sent.",
      remediation: "Fix the highlighted fields.",
      issues: draft.issues,
    });
  }
  const { event, credentialId, subjectSalt, document } = draft.value;
  onProgress({ step: "build", state: "done", detail: { credentialId } });

  onProgress({ step: "sign", state: "active" });
  const signature = await signTypedData(provider, account, credentialEventTypedData(event, domain));
  const message = buildCredentialMessage({ kind: "issuance", event, signature }, domain);
  if (!message.ok) throw new IssuerFlowError(classifyIssuerError(new Error("invalid signed message")));
  if (message.value.derived.signer !== account) throw signerMismatch(account, message.value.derived.signer);
  onProgress({ step: "sign", state: "done", detail: { digest: message.value.derived.digest } });

  onProgress({ step: "simulate", state: "active" });
  await dryRun(ctx, provider, account, encodeIssueCall(event, signature, SIMULATION_HCS_REF));
  onProgress({ step: "simulate", state: "done" });

  // D11: the consensus receipt is captured BEFORE the attestation is released to the registry.
  onProgress({ step: "publish", state: "active" });
  const hcs = await step(() =>
    ctx.backend.publish({ kind: "issuance", event: serializeCredentialEvent(event), signature }),
  );
  onProgress({ step: "publish", state: "done", detail: { hcs } });

  onProgress({ step: "register", state: "active" });
  const registration = await sendAndConfirm(
    ctx,
    provider,
    account,
    encodeIssueCall(event, signature, hcs.hcsRef),
    hash => {
      onProgress({ step: "register", state: "done", detail: { transactionHash: hash } });
      onProgress({ step: "confirm", state: "active", detail: { transactionHash: hash } });
    },
  );
  onProgress({ step: "confirm", state: "done", detail: { registration } });

  return {
    credentialId,
    event,
    subjectSalt,
    document,
    signature,
    digest: message.value.derived.digest,
    hcs,
    registration,
  };
}

export async function runRevocation(
  input: { credentialId: string; reason: RevocationReason },
  ctx: IssuerFlowContext,
  onProgress: ProgressListener<RevocationStep> = () => undefined,
): Promise<RevocationOutcome> {
  const domain = { chainId: ctx.chainId, verifyingContract: ctx.registryAddress };

  onProgress({ step: "status", state: "active" });
  const account = await requireIssuerAccount(ctx);
  const provider = ctx.provider as Eip1193Like;
  const preliminary = buildRevocationDraft({ ...input, issuer: `0x${"0".repeat(64)}`, nowSeconds: 0 });
  if (!preliminary.ok) {
    throw new IssuerFlowError({
      category: "invalid_input",
      code: "INVALID_INPUT",
      title: "Check the form",
      message: "Some fields are missing or invalid. Nothing was signed or sent.",
      remediation: "Fix the highlighted fields.",
      issues: preliminary.issues,
    });
  }
  const credentialId = preliminary.value.credentialId;
  const current = await step(() => ctx.backend.status(credentialId));
  if (current.status !== "issued") {
    throw new IssuerFlowError(
      describeRegistryError(
        current.status === "not_found"
          ? { name: "UnknownCredential", args: { credentialId } }
          : { name: "AlreadyRevoked", args: { credentialId, revokedAt: current.revokedAt } },
      ),
    );
  }
  onProgress({ step: "status", state: "done", detail: { status: current } });

  onProgress({ step: "sign", state: "active" });
  const built = buildRevocationDraft({
    ...input,
    credentialId,
    issuer: current.issuer,
    nowSeconds: Math.floor((ctx.now ?? Date.now)() / 1000),
  });
  if (!built.ok) throw new IssuerFlowError(classifyIssuerError(new Error("invalid revocation")));
  const revocation = built.value;
  const signature = await signTypedData(provider, account, credentialRevocationTypedData(revocation, domain));
  const message = buildCredentialMessage({ kind: "revocation", revocation, signature }, domain);
  if (!message.ok) throw new IssuerFlowError(classifyIssuerError(new Error("invalid signed message")));
  if (message.value.derived.signer !== account) throw signerMismatch(account, message.value.derived.signer);
  onProgress({ step: "sign", state: "done" });

  onProgress({ step: "simulate", state: "active" });
  const data = encodeRevokeCall(credentialId);
  await dryRun(ctx, provider, account, data);
  onProgress({ step: "simulate", state: "done" });

  // The revocation evidence is committed before the transaction, so the audit can check commit-before-execute.
  onProgress({ step: "publish", state: "active" });
  const hcs = await step(() =>
    ctx.backend.publish({ kind: "revocation", revocation: serializeCredentialRevocation(revocation), signature }),
  );
  onProgress({ step: "publish", state: "done", detail: { hcs } });

  onProgress({ step: "revoke", state: "active" });
  const registration = await sendAndConfirm(ctx, provider, account, data, hash => {
    onProgress({ step: "revoke", state: "done", detail: { transactionHash: hash } });
    onProgress({ step: "confirm", state: "active", detail: { transactionHash: hash } });
  });
  onProgress({ step: "confirm", state: "done", detail: { registration } });

  return { credentialId, revocation, signature, hcs, registration };
}
