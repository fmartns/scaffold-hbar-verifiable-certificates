/**
 * Deterministic credential fixtures: identities, events, signatures and the Mirror-shaped issuance/revocation evidence.
 * Keys are throwaway and control nothing; ECDSA (RFC 6979) makes every signature stable across runs.
 */
import { Interface, Wallet, ZeroHash, keccak256, toUtf8Bytes } from "ethers";
import { NETWORKS } from "../hedera/networks";
import {
  CREDENTIAL_EVENT_TYPES,
  CREDENTIAL_REVOCATION_TYPES,
  computeCredentialDigest,
  computeCredentialId,
  credentialDomain,
  encodeCredentialMessage,
} from "../hedera/hcs/credential-envelope";
import type { CredentialEvent, CredentialRevocation } from "../hedera/hcs/credential-envelope";
import type { Hex, SigningDomain } from "../hedera/hcs/envelope";
import { CREDENTIAL_REGISTRY_ABI } from "../hedera/audit/registry";
import type { FakeLog, FakeMessage, FakeRecord, FakeWorld } from "./mirror";

export const NETWORK = NETWORKS.testnet;
export const ISSUER_SIGNER = new Wallet(`0x${"11".repeat(32)}`);
export const ADMIN = new Wallet(`0x${"22".repeat(32)}`);
export const STRANGER = new Wallet(`0x${"33".repeat(32)}`);
export const REGISTRY = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
export const TOPIC = "0.0.4567";
export const DOMAIN: SigningDomain = { chainId: NETWORK.chainId, verifyingContract: REGISTRY };

export const b32 = (label: string) => keccak256(toUtf8Bytes(label)) as Hex;

export const ISSUER = b32("acme-university");

/** Unix seconds of the issuance block. */
export const ISSUED_AT = 1_767_225_600n;
export const REVOKED_AT = ISSUED_AT + 600n;

export function makeCredentialEvent(overrides: Partial<CredentialEvent> = {}): CredentialEvent {
  return {
    version: 1,
    issuer: ISSUER,
    externalCredentialId: b32("diploma:2026:0001"),
    credentialHash: b32("credential-document-v1"),
    subjectCommitment: b32("salted-subject-commitment"),
    schemaId: b32("schema:diploma:v1"),
    signedAt: ISSUED_AT - 5n,
    validUntil: ISSUED_AT + 600n,
    submitter: "0x0000000000000000000000000000000000000000",
    ...overrides,
  };
}

export const CREDENTIAL_ID = computeCredentialId(
  makeCredentialEvent().issuer,
  makeCredentialEvent().externalCredentialId,
);

export function makeRevocation(overrides: Partial<CredentialRevocation> = {}): CredentialRevocation {
  return {
    version: 1,
    credentialId: CREDENTIAL_ID,
    issuer: makeCredentialEvent().issuer,
    reasonCode: b32("reason:superseded"),
    signedAt: REVOKED_AT - 5n,
    ...overrides,
  };
}

/** Anything that signs EIP-712 typed data: an ethers `Wallet` or a Hardhat signer. */
export interface TypedDataSigner {
  signTypedData: Wallet["signTypedData"];
}

export const signIssuance = (event: CredentialEvent, signer: TypedDataSigner = ISSUER_SIGNER, domain = DOMAIN) =>
  signer.signTypedData(credentialDomain(domain), CREDENTIAL_EVENT_TYPES, event);

export const signRevocation = (
  revocation: CredentialRevocation,
  signer: TypedDataSigner = ISSUER_SIGNER,
  domain = DOMAIN,
) => signer.signTypedData(credentialDomain(domain), CREDENTIAL_REVOCATION_TYPES, revocation);

// ---------------------------------------------------------------------------------------------------------------------
// Scenario: a consistent issuance (and optionally revocation), from which tests remove or corrupt one piece
// ---------------------------------------------------------------------------------------------------------------------

const REGISTRY_IFACE = new Interface(CREDENTIAL_REGISTRY_ABI);

export const NOT_FOUND_RECORD: FakeRecord = {
  status: 0,
  issuer: ZeroHash,
  credentialHash: ZeroHash,
  subjectCommitment: ZeroHash,
  signer: "0x0000000000000000000000000000000000000000",
  issuedAt: 0n,
  revokedAt: 0n,
};

export const ISSUANCE_SEQUENCE = 5n;
export const REVOCATION_SEQUENCE = 9n;
export const HCS_ISSUANCE_TS = `${ISSUED_AT - 3n}.100000000`;
export const ISSUED_TX_TS = `${ISSUED_AT}.200000000`;
export const HCS_REVOCATION_TS = `${REVOKED_AT - 3n}.100000000`;
export const REVOKED_TX_TS = `${REVOKED_AT}.200000000`;
export const ISSUED_TX_HASH = `0x${"a1".repeat(32)}`;
export const REVOKED_TX_HASH = `0x${"b2".repeat(32)}`;

export const nsOf = (ts: string) => {
  const [s, n] = ts.split(".");
  return BigInt(s) * 1_000_000_000n + BigInt(n);
};

export function issuedLog(
  event: CredentialEvent,
  opts: { signer?: string; digest?: string; hcsSequence?: bigint; hcsTs?: string; ts?: string; txHash?: string } = {},
): FakeLog {
  const credentialId = computeCredentialId(event.issuer, event.externalCredentialId);
  const encoded = REGISTRY_IFACE.encodeEventLog("CredentialIssued", [
    credentialId,
    event.issuer,
    event.subjectCommitment,
    event.credentialHash,
    event.schemaId,
    opts.digest ?? computeCredentialDigest(event, DOMAIN),
    opts.signer ?? ISSUER_SIGNER.address,
    event.signedAt,
    opts.hcsSequence ?? ISSUANCE_SEQUENCE,
    nsOf(opts.hcsTs ?? HCS_ISSUANCE_TS),
  ]);
  return {
    topics: encoded.topics.map(t => t.toLowerCase()),
    data: encoded.data,
    consensusTimestamp: opts.ts ?? ISSUED_TX_TS,
    transactionHash: opts.txHash ?? ISSUED_TX_HASH,
  };
}

export function revokedLog(
  opts: { revokedBy?: string; byAdmin?: boolean; ts?: string; credentialId?: string } = {},
): FakeLog {
  const encoded = REGISTRY_IFACE.encodeEventLog("CredentialRevoked", [
    opts.credentialId ?? CREDENTIAL_ID,
    makeCredentialEvent().issuer,
    opts.revokedBy ?? ISSUER_SIGNER.address,
    opts.byAdmin ?? false,
    REVOKED_AT,
  ]);
  return {
    topics: encoded.topics.map(t => t.toLowerCase()),
    data: encoded.data,
    consensusTimestamp: opts.ts ?? REVOKED_TX_TS,
    transactionHash: REVOKED_TX_HASH,
  };
}

export function recordOf(event: CredentialEvent, status: 1 | 2 = 1, signer = ISSUER_SIGNER.address): FakeRecord {
  return {
    status,
    issuer: event.issuer,
    credentialHash: event.credentialHash,
    subjectCommitment: event.subjectCommitment,
    signer,
    issuedAt: ISSUED_AT,
    revokedAt: status === 2 ? REVOKED_AT : 0n,
  };
}

export async function issuanceMessage(
  event = makeCredentialEvent(),
  opts: { sequence?: bigint; ts?: string; signer?: Wallet } = {},
): Promise<FakeMessage> {
  return {
    sequence: opts.sequence ?? ISSUANCE_SEQUENCE,
    consensusTimestamp: opts.ts ?? HCS_ISSUANCE_TS,
    bytes: encodeCredentialMessage({ kind: "issuance", event, signature: await signIssuance(event, opts.signer) }),
  };
}

export async function revocationMessage(
  revocation = makeRevocation(),
  opts: { sequence?: bigint; ts?: string; signer?: Wallet } = {},
): Promise<FakeMessage> {
  return {
    sequence: opts.sequence ?? REVOCATION_SEQUENCE,
    consensusTimestamp: opts.ts ?? HCS_REVOCATION_TS,
    bytes: encodeCredentialMessage({
      kind: "revocation",
      revocation,
      signature: await signRevocation(revocation, opts.signer),
    }),
  };
}

/** A fully consistent world: issuance (and revocation when `revoked`). */
export async function consistentWorld(revoked = false): Promise<FakeWorld> {
  const event = makeCredentialEvent();
  const world: FakeWorld = {
    messages: [await issuanceMessage(event)],
    logs: [issuedLog(event)],
    records: new Map([[CREDENTIAL_ID, recordOf(event, revoked ? 2 : 1)]]),
  };
  if (revoked) {
    world.messages.push(await revocationMessage());
    world.logs.push(revokedLog());
  }
  return world;
}
