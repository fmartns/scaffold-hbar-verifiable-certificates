/**
 * `CredentialRegistry` (#9) as seen by the audit: the event signatures it emits, how to decode their logs, and
 * `statusOf(credentialId)` read over the JSON-RPC relay. `statusOf` is the AUTHORITY on a credential's state; Mirror
 * Node logs are evidence of how it got there. A Hardhat test pins these signatures against the compiled contract until
 * ABI codegen (#24) replaces the hand-written fragments.
 */
import { Interface, getAddress } from "ethers";
import type { HederaNetwork } from "../networks";
import type { Hex } from "../hcs/envelope";
import type { ContractLog } from "./mirror";

export const CREDENTIAL_REGISTRY_ABI = [
  "event CredentialIssued(bytes32 indexed credentialId, bytes32 indexed issuer, bytes32 indexed subjectCommitment, bytes32 credentialHash, bytes32 schemaId, bytes32 attestationDigest, address signer, uint64 signedAt, uint64 hcsSequence, uint64 hcsConsensusTimestampNs)",
  "event CredentialRevoked(bytes32 indexed credentialId, bytes32 indexed issuer, address indexed revokedBy, bool byAdmin, uint64 revokedAt)",
  "function statusOf(bytes32 credentialId) view returns (tuple(bytes32 issuer, bytes32 credentialHash, bytes32 subjectCommitment, address signer, uint64 issuedAt, uint64 revokedAt, uint8 status))",
] as const;

const REGISTRY = new Interface(CREDENTIAL_REGISTRY_ABI);

export const CREDENTIAL_ISSUED_TOPIC = REGISTRY.getEvent("CredentialIssued")!.topicHash as Hex;
export const CREDENTIAL_REVOKED_TOPIC = REGISTRY.getEvent("CredentialRevoked")!.topicHash as Hex;

export type OnChainCredentialStatus = "not_found" | "issued" | "revoked";

export interface OnChainCredentialRecord {
  status: OnChainCredentialStatus;
  issuer: Hex;
  credentialHash: Hex;
  subjectCommitment: Hex;
  signer: Hex;
  /** Unix seconds (block timestamp of the issuance); `0n` when not found. */
  issuedAt: bigint;
  /** Unix seconds; `0n` unless revoked. */
  revokedAt: bigint;
}

export interface CredentialIssuedLog {
  credentialId: Hex;
  issuer: Hex;
  subjectCommitment: Hex;
  credentialHash: Hex;
  schemaId: Hex;
  attestationDigest: Hex;
  signer: Hex;
  signedAt: bigint;
  hcsSequence: bigint;
  hcsConsensusTimestampNs: bigint;
}

export interface CredentialRevokedLog {
  credentialId: Hex;
  issuer: Hex;
  revokedBy: Hex;
  byAdmin: boolean;
  revokedAt: bigint;
}

const lower = (value: unknown) => String(value).toLowerCase() as Hex;

/** `null` when the log is not a well-formed `CredentialIssued`. */
export function decodeCredentialIssuedLog(log: Pick<ContractLog, "topics" | "data">): CredentialIssuedLog | null {
  if (log.topics[0]?.toLowerCase() !== CREDENTIAL_ISSUED_TOPIC) return null;
  try {
    const a = REGISTRY.decodeEventLog("CredentialIssued", log.data, log.topics);
    return {
      credentialId: lower(a.credentialId),
      issuer: lower(a.issuer),
      subjectCommitment: lower(a.subjectCommitment),
      credentialHash: lower(a.credentialHash),
      schemaId: lower(a.schemaId),
      attestationDigest: lower(a.attestationDigest),
      signer: lower(a.signer),
      signedAt: BigInt(a.signedAt),
      hcsSequence: BigInt(a.hcsSequence),
      hcsConsensusTimestampNs: BigInt(a.hcsConsensusTimestampNs),
    };
  } catch {
    return null;
  }
}

/** `null` when the log is not a well-formed `CredentialRevoked`. */
export function decodeCredentialRevokedLog(log: Pick<ContractLog, "topics" | "data">): CredentialRevokedLog | null {
  if (log.topics[0]?.toLowerCase() !== CREDENTIAL_REVOKED_TOPIC) return null;
  try {
    const a = REGISTRY.decodeEventLog("CredentialRevoked", log.data, log.topics);
    return {
      credentialId: lower(a.credentialId),
      issuer: lower(a.issuer),
      revokedBy: lower(a.revokedBy),
      byAdmin: Boolean(a.byAdmin),
      revokedAt: BigInt(a.revokedAt),
    };
  } catch {
    return null;
  }
}

export class RegistryReadError extends Error {
  readonly code = "REGISTRY_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "RegistryReadError";
  }
}

export interface CredentialStatusReader {
  /** Origin of the RPC endpoint, for provenance. */
  readonly origin: string;
  statusOf(credentialId: string): Promise<OnChainCredentialRecord>;
}

const STATUS: Record<number, OnChainCredentialStatus> = { 0: "not_found", 1: "issued", 2: "revoked" };

export function createCredentialStatusReader(options: {
  network: HederaNetwork;
  registryAddress: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): CredentialStatusReader {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const registryAddress = getAddress(options.registryAddress);
  const origin = new URL(options.network.rpcUrl).origin;
  const unavailable = (detail: string) =>
    new RegistryReadError(
      `Could not read the credential status from CredentialRegistry (${detail}). Check HEDERA_RPC_URL and HEDERA_CREDENTIAL_REGISTRY_ADDRESS.`,
    );

  return {
    origin,
    async statusOf(credentialId) {
      let body: { result?: unknown; error?: unknown };
      try {
        const response = await fetchImpl(options.network.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [{ to: registryAddress, data: REGISTRY.encodeFunctionData("statusOf", [credentialId]) }, "latest"],
          }),
        });
        if (!response.ok) throw unavailable(`HTTP ${response.status}`);
        body = (await response.json()) as typeof body;
      } catch (error) {
        throw error instanceof RegistryReadError ? error : unavailable("network error");
      }
      if (typeof body.result !== "string" || body.error) throw unavailable("the call reverted or returned nothing");
      try {
        const [r] = REGISTRY.decodeFunctionResult("statusOf", body.result);
        const status = STATUS[Number(r.status)];
        if (!status) throw new Error("unknown status");
        return {
          status,
          issuer: lower(r.issuer),
          credentialHash: lower(r.credentialHash),
          subjectCommitment: lower(r.subjectCommitment),
          signer: lower(r.signer),
          issuedAt: BigInt(r.issuedAt),
          revokedAt: BigInt(r.revokedAt),
        };
      } catch {
        throw unavailable("malformed answer; is HEDERA_CREDENTIAL_REGISTRY_ADDRESS a CredentialRegistry?");
      }
    },
  };
}
