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
  "function hcsTopicNum() view returns (uint64)",
  "function paused() view returns (bool)",
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
  /** `unavailable`: the relay did not answer usably. `not_registry`: it answered, but not like a CredentialRegistry. */
  readonly reason: "unavailable" | "not_registry";
  constructor(message: string, reason: "unavailable" | "not_registry" = "unavailable") {
    super(message);
    this.name = "RegistryReadError";
    this.reason = reason;
  }
}

interface RegistryCallOptions {
  network: HederaNetwork;
  registryAddress: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const readError = (detail: string, reason?: RegistryReadError["reason"]) =>
  new RegistryReadError(
    `Could not read the credential status from CredentialRegistry (${detail}). Check HEDERA_RPC_URL and HEDERA_CREDENTIAL_REGISTRY_ADDRESS.`,
    reason,
  );
const unavailable = (detail: string) => readError(detail);
const notRegistry = () =>
  readError("malformed answer; is HEDERA_CREDENTIAL_REGISTRY_ADDRESS a CredentialRegistry?", "not_registry");

/** `eth_call` over the relay; returns the raw result. */
async function callRegistry(options: RegistryCallOptions, data: string): Promise<string> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
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
        params: [{ to: getAddress(options.registryAddress), data }, "latest"],
      }),
    });
    if (!response.ok) throw unavailable(`HTTP ${response.status}`);
    body = (await response.json()) as typeof body;
  } catch (error) {
    throw error instanceof RegistryReadError ? error : unavailable("network error");
  }
  if (typeof body.result !== "string" || body.error) throw unavailable("the call reverted or returned nothing");
  return body.result;
}

export interface RegistryDeployment {
  /** Number of the HCS topic the registry was deployed for (`0.0.<hcsTopicNum>`). */
  hcsTopicNum: bigint;
  /** Issuance is paused (revocation still works). */
  paused: boolean;
}

/**
 * Reads the deployment-level state of a `CredentialRegistry`. An address without a contract answers `0x`, which is
 * reported as `not_registry`, distinct from a relay that did not answer.
 */
export async function readRegistryDeployment(options: RegistryCallOptions): Promise<RegistryDeployment> {
  const [topic, paused] = await Promise.all([
    callRegistry(options, REGISTRY.encodeFunctionData("hcsTopicNum")),
    callRegistry(options, REGISTRY.encodeFunctionData("paused")),
  ]);
  try {
    return {
      hcsTopicNum: BigInt(REGISTRY.decodeFunctionResult("hcsTopicNum", topic)[0]),
      paused: Boolean(REGISTRY.decodeFunctionResult("paused", paused)[0]),
    };
  } catch {
    throw notRegistry();
  }
}

export interface CredentialStatusReader {
  /** Origin of the RPC endpoint, for provenance. */
  readonly origin: string;
  statusOf(credentialId: string): Promise<OnChainCredentialRecord>;
}

const STATUS: Record<number, OnChainCredentialStatus> = { 0: "not_found", 1: "issued", 2: "revoked" };

export function createCredentialStatusReader(options: RegistryCallOptions): CredentialStatusReader {
  getAddress(options.registryAddress);
  const origin = new URL(options.network.rpcUrl).origin;

  return {
    origin,
    async statusOf(credentialId) {
      const result = await callRegistry(options, REGISTRY.encodeFunctionData("statusOf", [credentialId]));
      try {
        const [r] = REGISTRY.decodeFunctionResult("statusOf", result);
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
        throw notRegistry();
      }
    },
  };
}
